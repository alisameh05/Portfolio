#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const SAFE_RESPONSE_ENUM_NARROWING = new Set([
  // This Owner command always returns the relationship-specific outcome. Its
  // dedicated receipt schema makes that invariant explicit for generated clients.
  "POST /api/owner/v1/projects/{projectId}/commands/relate-project response 200 application/json.outcome",
]);

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).sort().join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function localReference(document, reference) {
  if (!reference?.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, segment) => value?.[segment], document);
}

function dereference(document, value) {
  return value?.$ref ? localReference(document, value.$ref) : value;
}

function asTypes(schema) {
  const type = schema?.type;
  if (Array.isArray(type)) return new Set(type);
  if (typeof type === "string") return new Set([type]);
  return new Set();
}

function compareSchemas({ baselineDocument, candidateDocument, baselineSchema, candidateSchema, location, mode, changes, seen }) {
  const baseline = dereference(baselineDocument, baselineSchema);
  const candidate = dereference(candidateDocument, candidateSchema);

  if (!baseline || !candidate) {
    if (baseline && !candidate) changes.push(`${location}: schema removed`);
    return;
  }

  const pair = `${baselineSchema?.$ref ?? location}|${candidateSchema?.$ref ?? location}|${mode}`;
  if (seen.has(pair)) return;
  seen.add(pair);

  const baselineTypes = asTypes(baseline);
  const candidateTypes = asTypes(candidate);
  for (const type of baselineTypes) {
    if (candidateTypes.size > 0 && !candidateTypes.has(type)) {
      changes.push(`${location}: accepted type ${type} removed`);
    }
  }

  if ("const" in baseline && canonical(baseline.const) !== canonical(candidate.const)) {
    changes.push(`${location}: const value changed`);
  }

  if (Array.isArray(baseline.enum)) {
    const candidateValues = new Set((candidate.enum ?? []).map(canonical));
    const removed = baseline.enum.filter((value) => !candidateValues.has(canonical(value)));
    const approvedRelationshipReceiptNarrowing =
      mode === "output" &&
      SAFE_RESPONSE_ENUM_NARROWING.has(location) &&
      canonical(candidate.enum) === canonical(["project-related"]) &&
      baseline.enum.some((value) => canonical(value) === canonical("project-related"));
    if (removed.length > 0 && !approvedRelationshipReceiptNarrowing) {
      changes.push(`${location}: enum narrowed; removed ${removed.map(canonical).join(", ")}`);
    }
  }

  const lowerBounds = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"];
  for (const keyword of lowerBounds) {
    if (candidate[keyword] !== undefined && (baseline[keyword] === undefined || candidate[keyword] > baseline[keyword])) {
      changes.push(`${location}: input narrowed by ${keyword}`);
    }
  }
  const upperBounds = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"];
  for (const keyword of upperBounds) {
    if (candidate[keyword] !== undefined && (baseline[keyword] === undefined || candidate[keyword] < baseline[keyword])) {
      changes.push(`${location}: input narrowed by ${keyword}`);
    }
  }
  if (candidate.pattern !== undefined && canonical(candidate.pattern) !== canonical(baseline.pattern)) {
    changes.push(`${location}: input narrowed by changed pattern`);
  }

  const baselineRequired = new Set(baseline.required ?? []);
  const candidateRequired = new Set(candidate.required ?? []);
  if (mode === "input") {
    for (const property of candidateRequired) {
      if (!baselineRequired.has(property)) {
        changes.push(`${location}.${property}: new required input`);
      }
    }
  } else {
    for (const property of baselineRequired) {
      if (!candidateRequired.has(property)) {
        changes.push(`${location}.${property}: required response field became optional`);
      }
    }
  }

  for (const [property, schema] of Object.entries(baseline.properties ?? {})) {
    const candidateProperty = candidate.properties?.[property];
    if (!candidateProperty) {
      changes.push(`${location}.${property}: field removed`);
      continue;
    }
    compareSchemas({
      baselineDocument,
      candidateDocument,
      baselineSchema: schema,
      candidateSchema: candidateProperty,
      location: `${location}.${property}`,
      mode,
      changes,
      seen,
    });
  }

  if (mode === "input" && baseline.additionalProperties !== false && candidate.additionalProperties === false) {
    changes.push(`${location}: input narrowed by disabling additional properties`);
  }

  if (baseline.items) {
    if (!candidate.items) {
      changes.push(`${location}: array item schema removed`);
    } else {
      compareSchemas({
        baselineDocument,
        candidateDocument,
        baselineSchema: baseline.items,
        candidateSchema: candidate.items,
        location: `${location}[]`,
        mode,
        changes,
        seen,
      });
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (!baseline[keyword]) continue;
    if (!candidate[keyword] || candidate[keyword].length < baseline[keyword].length) {
      changes.push(`${location}: ${keyword} alternative removed`);
      continue;
    }
    baseline[keyword].forEach((schema, index) => {
      compareSchemas({
        baselineDocument,
        candidateDocument,
        baselineSchema: schema,
        candidateSchema: candidate[keyword][index],
        location: `${location}.${keyword}[${index}]`,
        mode,
        changes,
        seen,
      });
    });
  }
}

function operationParameters(document, pathItem, operation) {
  const parameters = [...(pathItem?.parameters ?? []), ...(operation?.parameters ?? [])];
  return new Map(
    parameters.map((entry) => {
      const parameter = dereference(document, entry);
      return [`${parameter?.in}:${parameter?.name}`, parameter];
    }),
  );
}

function compareContent(baselineDocument, candidateDocument, baselineContent, candidateContent, location, mode, changes) {
  for (const [mediaType, baselineMedia] of Object.entries(baselineContent ?? {})) {
    const candidateMedia = candidateContent?.[mediaType];
    if (!candidateMedia) {
      changes.push(`${location}: media type ${mediaType} removed`);
      continue;
    }
    compareSchemas({
      baselineDocument,
      candidateDocument,
      baselineSchema: baselineMedia.schema,
      candidateSchema: candidateMedia.schema,
      location: `${location} ${mediaType}`,
      mode,
      changes,
      seen: new Set(),
    });
  }
}

export function findBreakingChanges(baselineDocument, candidateDocument) {
  const changes = [];

  for (const [path, baselinePathItem] of Object.entries(baselineDocument.paths ?? {})) {
    const candidatePathItem = candidateDocument.paths?.[path];
    if (!candidatePathItem) {
      changes.push(`${path}: path removed`);
      continue;
    }

    for (const [method, baselineOperation] of Object.entries(baselinePathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const candidateOperation = candidatePathItem[method];
      const operationLocation = `${method.toUpperCase()} ${path}`;
      if (!candidateOperation) {
        changes.push(`${operationLocation}: operation removed`);
        continue;
      }

      if (baselineOperation.operationId !== candidateOperation.operationId) {
        changes.push(`${operationLocation}: operationId changed`);
      }

      const baselineSecurity = baselineOperation.security ?? baselineDocument.security ?? [];
      const candidateSecurity = candidateOperation.security ?? candidateDocument.security ?? [];
      if (canonical(baselineSecurity) !== canonical(candidateSecurity)) {
        changes.push(`${operationLocation}: security changed`);
      }

      const baselineParameters = operationParameters(baselineDocument, baselinePathItem, baselineOperation);
      const candidateParameters = operationParameters(candidateDocument, candidatePathItem, candidateOperation);
      for (const [key, baselineParameter] of baselineParameters) {
        const candidateParameter = candidateParameters.get(key);
        if (!candidateParameter) {
          changes.push(`${operationLocation}: parameter ${key} removed`);
          continue;
        }
        if (!baselineParameter.required && candidateParameter.required) {
          changes.push(`${operationLocation}: parameter ${key} is a new required input`);
        }
        compareSchemas({
          baselineDocument,
          candidateDocument,
          baselineSchema: baselineParameter.schema,
          candidateSchema: candidateParameter.schema,
          location: `${operationLocation} parameter ${key}`,
          mode: "input",
          changes,
          seen: new Set(),
        });
      }
      for (const [key, candidateParameter] of candidateParameters) {
        if (!baselineParameters.has(key) && candidateParameter.required) {
          changes.push(`${operationLocation}: parameter ${key} is a new required input`);
        }
      }

      const baselineRequest = dereference(baselineDocument, baselineOperation.requestBody);
      const candidateRequest = dereference(candidateDocument, candidateOperation.requestBody);
      if (!baselineRequest && candidateRequest?.required) {
        changes.push(`${operationLocation}: request body is a new required input`);
      } else if (baselineRequest && !baselineRequest.required && candidateRequest?.required) {
        changes.push(`${operationLocation}: request body is a new required input`);
      }
      if (baselineRequest && candidateRequest) {
        compareContent(
          baselineDocument,
          candidateDocument,
          baselineRequest.content,
          candidateRequest.content,
          `${operationLocation} request`,
          "input",
          changes,
        );
      }

      for (const [status, baselineResponseReference] of Object.entries(baselineOperation.responses ?? {})) {
        const candidateResponseReference = candidateOperation.responses?.[status];
        if (!candidateResponseReference) {
          changes.push(`${operationLocation}: response status ${status} removed`);
          continue;
        }
        const baselineResponse = dereference(baselineDocument, baselineResponseReference);
        const candidateResponse = dereference(candidateDocument, candidateResponseReference);
        compareContent(
          baselineDocument,
          candidateDocument,
          baselineResponse?.content,
          candidateResponse?.content,
          `${operationLocation} response ${status}`,
          "output",
          changes,
        );
      }
    }
  }

  for (const [name, baselineScheme] of Object.entries(baselineDocument.components?.securitySchemes ?? {})) {
    const candidateScheme = candidateDocument.components?.securitySchemes?.[name];
    if (!candidateScheme || canonical(baselineScheme) !== canonical(candidateScheme)) {
      changes.push(`security scheme ${name}: security changed`);
    }
  }

  return [...new Set(changes)].sort();
}

function readDocument(path, role) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    throw new Error(`${role} contract not found: ${path}`);
  }
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument.startsWith("--")) options[argument.slice(2)] = arguments_[index + 1];
    if (argument.startsWith("--")) index += 1;
  }
  return options;
}

function checkPair({ baseline, candidate, surface }) {
  const baselineDocument = readDocument(baseline, "Compatibility baseline");
  const candidateDocument = readDocument(candidate, "Candidate");
  const changes = findBreakingChanges(baselineDocument, candidateDocument);
  if (changes.length > 0) {
    console.error(`✗ ${surface}: ${changes.length} backward-incompatible change(s)`);
    changes.forEach((change) => console.error(`  - ${change}`));
    return false;
  }
  console.log(`✓ ${surface}: candidate is backward compatible with the committed master baseline`);
  return true;
}

export function main(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_);
  const pairs = options.baseline || options.candidate
    ? [{
        baseline: options.baseline,
        candidate: options.candidate,
        surface: options.surface ?? "contract",
      }]
    : [
        {
          baseline: "openapi/baseline/master/public-v1.json",
          candidate: "openapi/generated/public-v1.json",
          surface: "public-v1",
        },
        {
          baseline: "openapi/baseline/master/owner-v1.json",
          candidate: "openapi/generated/owner-v1.json",
          surface: "owner-v1",
        },
      ];

  if (pairs.some((pair) => !pair.baseline || !pair.candidate)) {
    throw new Error("Both --baseline and --candidate are required when either is provided.");
  }

  return pairs.every(checkPair) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`✗ contract compatibility check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
