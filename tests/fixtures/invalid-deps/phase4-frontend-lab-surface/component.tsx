/**
 * Fixture: phase4-frontend-lab-surface
 *
 * Intentionally combines React presentation, browser state, and a Lab entry
 * surface. Expected to fail with rule: frontend-browser-lab-surface
 */
import React from "react";

export type LabEntry = { id: string };

export function Component() {
  const stored = localStorage.getItem("lab-entry");
  return React.createElement("div", null, stored ?? "lab-entry");
}
