/** Stop and remove every isolated project in reverse creation order. */
export function cleanupIsolatedProjects(projects, { stop, remove }) {
  const failures = [];
  for (const project of [...projects].reverse()) {
    try {
      stop(project);
      remove(project.workdir);
    } catch {
      failures.push(project.projectId);
    }
  }
  return failures;
}
