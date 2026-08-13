import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'server-basepath';

/**
 * Extract base path from servers[0].url and prepend to all paths.
 * - Skip if path is "/", empty, or contains template variables
 * - Remove server hostnames from the spec
 */
export function serverBasepath(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  const servers = result.servers;

  if (!servers || !Array.isArray(servers) || servers.length === 0) {
    return result;
  }

  const serverUrl = servers[0].url;
  if (!serverUrl) return result;

  // Skip if the original URL contains template variables anywhere
  if (serverUrl.includes('{')) {
    diag.warn(RULE, '#/servers/0/url', 'template-basepath', 'skipped',
      `Server URL '${serverUrl}' contains template variables, skipping base path extraction`, serverUrl);
    stripServerHostnames(result, diag);
    return result;
  }

  const basePath = extractBasePath(serverUrl);

  // Skip if no meaningful base path
  if (!basePath || basePath === '/') {
    // Still strip hostnames from servers
    stripServerHostnames(result, diag);
    return result;
  }

  diag.info(RULE, '#/servers/0/url', 'server-basepath', 'converted',
    `Extracting base path '${basePath}' and prepending to all paths`);

  // Prepend base path to all paths
  const paths = result.paths;
  if (paths) {
    const newPaths: Record<string, any> = {};
    for (const [path, pathItem] of Object.entries(paths)) {
      const newPath = normalizePath(`${basePath}${path}`);
      newPaths[newPath] = pathItem;
      diag.info(RULE, `#/paths/${path}`, 'path-prefix', 'converted',
        `Prepended base path: '${path}' → '${newPath}'`);
    }
    result.paths = newPaths;
  }

  // Reset server URL to root after extracting base path
  result.servers![0].url = '/';

  // Strip hostnames from remaining servers
  stripServerHostnames(result, diag);

  return result;
}

function extractBasePath(url: string): string {
  try {
    // Handle relative URLs
    if (url.startsWith('/')) {
      return url.replace(/\/$/, '');
    }
    // Try standard URL parsing first (works for well-formed URLs)
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/$/, '');
  } catch {
    // Fallback: manually extract path from URLs with template variables etc.
    const match = url.match(/^https?:\/\/[^/]+(\/.*?)?\/?$/);
    if (match?.[1]) {
      return match[1].replace(/\/$/, '');
    }
    // Last resort: strip protocol + host portion
    const slashIdx = url.indexOf('/', url.indexOf('//') + 2);
    if (slashIdx >= 0) {
      return url.slice(slashIdx).replace(/\/$/, '');
    }
    return '';
  }
}

function normalizePath(path: string): string {
  // Remove double slashes
  return path.replace(/\/+/g, '/');
}

function stripServerHostnames(spec: OpenAPISpec, diag: Diagnostics): void {
  if (!spec.servers) return;

  // Replace servers with just the path or remove
  spec.servers = spec.servers
    .map((s: any) => {
      if (!s.url) return s;
      try {
        const basePath = extractBasePath(s.url);
        return { ...s, url: basePath || '/' };
      } catch {
        return s;
      }
    });
}
