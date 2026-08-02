/** Shared YAML conformance cases used by codec and black-box CLI/web tests. */
export interface ConfigYamlConformanceCase {
  name: string;
  yaml: string;
  valid: boolean;
  backendKind: "flatfile" | "remote";
  project?: string;
  jira?: string | null;
  staleAfter?: string;
}

export const CONFIG_YAML_CONFORMANCE_CASES: readonly ConfigYamlConformanceCase[] = [
  {
    name: "bare backend",
    yaml: "project: bare-backend\nbackend:\n",
    valid: true,
    backendKind: "flatfile",
    project: "bare-backend",
    jira: null,
    staleAfter: "60m",
  },
  {
    name: "quoted escapes",
    yaml: 'project: "quoted\\nproject"\nbackend: flatfile\n',
    valid: true,
    backendKind: "flatfile",
    project: "quoted\nproject",
    jira: null,
    staleAfter: "60m",
  },
  {
    name: "boolean where the schema requires a string",
    yaml: "project: true\nbackend: remote\n",
    valid: false,
    // Invalid config is rejected consistently. Tolerant storage selection
    // falls back to flatfile; strict CLI reads fail; web returns a warning.
    backendKind: "flatfile",
  },
  {
    name: "flow maps",
    yaml:
      'project: flow-map\nremotes: { jira: "https://jira.example.test" }\n' +
      'defaults: { stale_after: 30m, review_stale_after: 6h, lock_timeout: 2s }\n' +
      'backend: { kind: remote, url: "https://slop.example.test" }\n',
    valid: true,
    backendKind: "remote",
    project: "flow-map",
    jira: "https://jira.example.test",
    staleAfter: "30m",
  },
  {
    name: "block scalar",
    yaml: "project: |-\n  block\n  project\nbackend: flatfile\n",
    valid: true,
    backendKind: "flatfile",
    project: "block\nproject",
    jira: null,
    staleAfter: "60m",
  },
];
