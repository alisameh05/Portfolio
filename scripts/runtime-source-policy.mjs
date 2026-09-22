const PROVIDER_SPEC = "(?:next\\/|@supabase\\/|kysely(?:\\/|\"|')|@vercel\\/|vercel(?:\\/|\"|'))";
const GENERATED_SPEC = "(?:src\\/contracts\\/http\\/|@hey-api\\/openapi-ts|@redocly\\/|openapi-typescript|(?:\\.\\.?\\/)+contracts\\/http\\/)";
const PROVIDER_IMPORT = new RegExp(`(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)["']${PROVIDER_SPEC}`, "i");
const PROVIDER_EXPORT_FROM = new RegExp(`export\\s+[^;]*?\\bfrom\\s+["']${PROVIDER_SPEC}`, "i");
const GENERATED_IMPORT = new RegExp(`(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)["']${GENERATED_SPEC}`);
const GENERATED_EXPORT_FROM = new RegExp(`export\\s+[^;]*?\\bfrom\\s+["']${GENERATED_SPEC}`);
const SHARED_VALIDATOR_IMPORT = /from\s+["'](?:zod|valibot|@supabase\/|kysely|next\/|@vercel\/|@hey-api\/openapi-ts|@redocly\/|openapi-typescript)/i;
const LAB_ENTRY_DEF = /\b(?:class|function|interface|type)\s+LabEntry\b/i;
const LAB_ENTRY_LITERAL = /\blab[-_ ]?entry\b/i;
const LAB_PATH = /\/lab(?:\/|$)/i;
const REACT_IMPORT = /from\s+["']react["']/;
const BROWSER_STATE = /\b(?:localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie/;
const SERVER_STUB_HINT = /generated[\s_-]*server[\s_-]*stub|server[\s_-]*stub|openapi-generator/i;
const FRONTEND_STYLE_FILE = /\.(?:css|scss|sass|less|styl)$/i;

function isDomainOrApplicationFile(relativePath) {
  return /^src\/modules\/[^/]+\/(?:domain|application)\//.test(relativePath);
}

function isSharedDomainFile(relativePath) {
  return /^src\/shared\/domain\//.test(relativePath);
}

export function forbiddenSourceReasons(relativePath, content) {
  const reasons = [];
  const base = relativePath.split("/").at(-1) ?? "";
  if (
    LAB_ENTRY_DEF.test(content) ||
    LAB_ENTRY_LITERAL.test(content) ||
    (LAB_PATH.test(relativePath) && !/openapi\//.test(relativePath))
  ) {
    reasons.push("lab-entry-surface");
  }
  if (/\.(?:tsx|jsx)$/.test(base)) reasons.push("jsx-tsx-surface");
  if (FRONTEND_STYLE_FILE.test(base)) reasons.push("frontend-style-surface");
  if (REACT_IMPORT.test(content)) reasons.push("react-presentation-import");
  if (BROWSER_STATE.test(content)) reasons.push("browser-state");
  if (SERVER_STUB_HINT.test(content)) reasons.push("generated-server-stub");
  if (isDomainOrApplicationFile(relativePath)) {
    if (PROVIDER_IMPORT.test(content) || PROVIDER_EXPORT_FROM.test(content)) {
      reasons.push("provider-import-in-domain-or-application");
    }
    if (GENERATED_IMPORT.test(content) || GENERATED_EXPORT_FROM.test(content)) {
      reasons.push("generated-transport-import-in-domain-or-application");
    }
  }
  if (isSharedDomainFile(relativePath) && SHARED_VALIDATOR_IMPORT.test(content)) {
    reasons.push("provider-or-validator-import-in-shared-domain");
  }
  return reasons;
}
