import { describe, it, expect } from 'vitest';
import { sanitizeNames } from '../../src/transforms/sanitize-names.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('sanitizeNames', () => {
  it('renames schemas with underscores to alphanumeric', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: {
        schemas: {
          Identification_0: { type: 'object' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(result.components.schemas.Identification0).toBeDefined();
    expect(result.components.schemas.Identification_0).toBeUndefined();
  });

  it('handles name collisions with V2 suffix', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: {
        schemas: {
          'OBRate1_0': { type: 'object' },
          'OB_Rate1_0': { type: 'object' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    const schemaNames = Object.keys(result.components.schemas);
    // Both should exist with distinct names
    expect(schemaNames).toHaveLength(2);
    expect(schemaNames).toContain('OBRate10');
    expect(schemaNames.some(n => n.startsWith('OBRate10V'))).toBe(true);
    // Should have a collision warning
    expect(diag.entries.some(e => e.feature === 'schema-name-collision')).toBe(true);
  });

  it('updates all $ref references when renaming', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/My_Type' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          My_Type: {
            type: 'object',
            properties: {
              child: { $ref: '#/components/schemas/Child_Type' },
            },
          },
          Child_Type: { type: 'string' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    // Refs should be updated
    const respSchema = result.paths['/test'].get.responses['200'].content['application/json'].schema;
    expect(respSchema.$ref).toBe('#/components/schemas/MyType');
    expect(result.components.schemas.MyType.properties.child.$ref)
      .toBe('#/components/schemas/ChildType');
  });

  it('leaves already-clean names unchanged', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Pet: { type: 'object' } } },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(result.components.schemas.Pet).toBeDefined();
    expect(diag.entries.filter(e => e.feature === 'schema-name')).toHaveLength(0);
  });

  it('warns about reserved paths', () => {
    const spec = {
      openapi: '3.0.0',
      paths: { '/ping': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    sanitizeNames(spec, diag);
    expect(diag.entries.some(e => e.feature === 'reserved-path')).toBe(true);
  });

  it('removes paths with embedded path parameters (mid-segment residual after embeddedPathParamSplit)', () => {
    // embeddedPathParamSplit runs before sanitizeNames in the pipeline and rewrites
    // whole-segment forms (/{id}.json, /{id}:action). The check restored here is a
    // safety net for mid-segment cases that embeddedPathParamSplit cannot handle
    // (e.g. /resource{id}, /agents.{runmode}.-1.json); API Gateway would reject
    // these at deploy time, so we drop them with a breaking diagnostic.
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/valid/{id}': { get: { responses: { '200': { description: 'OK' } } } },
        '/agents.{runmode}.-1.json': { get: { responses: { '200': { description: 'OK' } } } },
        '/resource{id}': { post: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(result.paths!['/valid/{id}']).toBeDefined();
    expect(result.paths!['/agents.{runmode}.-1.json']).toBeUndefined();
    expect(result.paths!['/resource{id}']).toBeUndefined();
    expect(diag.entries.filter(e => e.feature === 'embedded-path-param' && e.action === 'removed')).toHaveLength(2);
  });

  it('removes paths with no operations', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/with-ops': { get: { responses: { '200': { description: 'OK' } } } },
        '/no-ops': { summary: 'No methods here' },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(result.paths!['/with-ops']).toBeDefined();
    expect(result.paths!['/no-ops']).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'empty-path' && e.action === 'removed')).toBe(true);
  });

  it('keeps paths with valid special characters (dots, colons, commas)', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/api/v1.0/resources': { get: { responses: { '200': { description: 'OK' } } } },
        '/config/com.adobe.granite': { get: { responses: { '200': { description: 'OK' } } } },
        '/items.json': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(result.paths!['/api/v1.0/resources']).toBeDefined();
    expect(result.paths!['/config/com.adobe.granite']).toBeDefined();
    expect(result.paths!['/items.json']).toBeDefined();
  });

  it('removes paths with invalid characters', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/valid/path': { get: { responses: { '200': { description: 'OK' } } } },
        '/invalid/p@th': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(result.paths!['/valid/path']).toBeDefined();
    expect(result.paths!['/invalid/p@th']).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'invalid-path-chars' && e.action === 'removed')).toBe(true);
  });

  it('does not mutate original spec', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { 'A_B': { type: 'string' } } },
    };
    const diag = createDiagnostics();
    sanitizeNames(spec, diag);
    expect(spec.components.schemas['A_B']).toBeDefined();
  });

  it('renames conflicting sibling path parameters to the winner', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/settings/{settingId}': { get: { responses: { '200': { description: 'OK' } } } },
        '/settings/{settingKeyOrId}/value': { get: { responses: { '200': { description: 'OK' } } } },
        '/other/{id}': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    // Frequency tie (1 each); lexicographic tiebreak on firstSeen path:
    // '/settings/{settingId}' < '/settings/{settingKeyOrId}/value', so 'settingId' wins.
    // The loser path is renamed, not removed.
    expect(result.paths!['/settings/{settingId}']).toBeDefined();
    expect(result.paths!['/settings/{settingId}/value']).toBeDefined();
    expect(result.paths!['/settings/{settingKeyOrId}/value']).toBeUndefined();
    expect(result.paths!['/other/{id}']).toBeDefined();
    expect(diag.entries.some(e =>
      e.feature === 'sibling-path-param-conflict' && e.action === 'renamed'
    )).toBe(true);
  });

  it('allows same param name across sibling paths', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/users/{userId}': { get: { responses: { '200': { description: 'OK' } } } },
        '/users/{userId}/posts': { get: { responses: { '200': { description: 'OK' } } } },
        '/users/{userId}/comments': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(Object.keys(result.paths!)).toHaveLength(3);
    expect(diag.entries.filter(e => e.feature === 'sibling-path-param-conflict')).toHaveLength(0);
  });

  it('resolves deep sibling path parameter conflicts via rename', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/{path}/': { get: { responses: { '200': { description: 'OK' } } } },
        '/{intermediatePath}/{authId}/keystore': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    // Frequency tie at segment 0 (prefix ''). Lex tiebreak on firstSeen:
    // '/{intermediatePath}/{authId}/keystore' < '/{path}/', so 'intermediatePath' wins.
    // '/{path}/' is renamed, not removed; no conflict at segment 1 (only one path reaches that depth).
    // (Trailing slash is normalized away during rewrite — this matches how API Gateway treats paths.)
    expect(result.paths!['/{path}/']).toBeUndefined();
    expect(result.paths!['/{intermediatePath}']).toBeDefined();
    expect(result.paths!['/{intermediatePath}/{authId}/keystore']).toBeDefined();
  });

  describe('sibling-path-param rename pass', () => {
    it('renames lower-frequency param to match higher-frequency winner, keeping both paths', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/users/{userId}': { get: { parameters: [{ in: 'path', name: 'userId', required: true }], responses: { '200': { description: 'ok' } } } },
          '/users/{userId}/posts': { get: { parameters: [{ in: 'path', name: 'userId', required: true }], responses: { '200': { description: 'ok' } } } },
          '/users/{userId}/comments': { get: { parameters: [{ in: 'path', name: 'userId', required: true }], responses: { '200': { description: 'ok' } } } },
          '/users/{uid}/settings': { get: { parameters: [{ in: 'path', name: 'uid', required: true }], responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      const result = sanitizeNames(spec, diag);
      const paths = Object.keys(result.paths);
      expect(paths).toContain('/users/{userId}/settings');
      expect(paths).not.toContain('/users/{uid}/settings');
      expect(paths).toHaveLength(4);

      const renameEntries = diag.entries.filter(e => e.feature === 'sibling-path-param-conflict' && e.action === 'renamed');
      expect(renameEntries).toHaveLength(1);
      expect(renameEntries[0].level).toBe('warning');

      const renamedParam = result.paths['/users/{userId}/settings'].get.parameters[0];
      expect(renamedParam.name).toBe('userId');
    });

    it('frequency tie broken by lexicographically smallest firstSeen path', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/items/{beta}/x': { get: { parameters: [{ in: 'path', name: 'beta', required: true }], responses: { '200': { description: 'ok' } } } },
          '/items/{alpha}/y': { get: { parameters: [{ in: 'path', name: 'alpha', required: true }], responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      const result = sanitizeNames(spec, diag);
      const paths = Object.keys(result.paths);
      expect(paths).toContain('/items/{alpha}/y');
      expect(paths).toContain('/items/{alpha}/x');
      expect(paths).not.toContain('/items/{beta}/x');
    });

    it('drops with breaking diagnostic on hard rename-collision', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/x/{a}/y': { get: { parameters: [{ in: 'path', name: 'a', required: true }], responses: { '200': { description: 'ok' } } } },
          '/x/{a}/y-dup-placeholder-A': { get: { parameters: [{ in: 'path', name: 'a', required: true }], responses: { '200': { description: 'ok' } } } },
          '/x/{b}/y': { get: { parameters: [{ in: 'path', name: 'b', required: true }], responses: { '200': { description: 'ok' } } } },
        },
      };
      // Winner at segment 0 of prefix '/x' is 'a' (appears twice vs 'b' once).
      // Renaming '/x/{b}/y' → '/x/{a}/y' collides with the existing '/x/{a}/y'.
      const diag = createDiagnostics();
      const result = sanitizeNames(spec, diag);
      expect(result.paths['/x/{b}/y']).toBeUndefined();
      expect(result.paths['/x/{a}/y']).toBeDefined();

      const collisionEntries = diag.entries.filter(e => e.feature === 'sibling-rename-collision');
      expect(collisionEntries).toHaveLength(1);
      expect(collisionEntries[0].level).toBe('breaking');
      expect(collisionEntries[0].action).toBe('removed');
    });

    it('renames multi-segment conflicts independently', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/a/{p1}/b/{p2}': { get: { parameters: [{ in: 'path', name: 'p1' }, { in: 'path', name: 'p2' }], responses: { '200': { description: 'ok' } } } },
          '/a/{p1}/b/{p2b}': { get: { parameters: [{ in: 'path', name: 'p1' }, { in: 'path', name: 'p2b' }], responses: { '200': { description: 'ok' } } } },
          '/a/{p1alt}/b/{p2}': { get: { parameters: [{ in: 'path', name: 'p1alt' }, { in: 'path', name: 'p2' }], responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      const result = sanitizeNames(spec, diag);
      // p1 wins at segment 0 (freq 2 vs 1), p2 wins at segment 2 (freq 2 vs 1).
      // Both sibling-disagreeing paths rename to '/a/{p1}/b/{p2}', which already exists
      // → both are dropped via sibling-rename-collision.
      expect(result.paths['/a/{p1}/b/{p2}']).toBeDefined();
      expect(result.paths['/a/{p1}/b/{p2b}']).toBeUndefined();
      expect(result.paths['/a/{p1alt}/b/{p2}']).toBeUndefined();
      const collisions = diag.entries.filter(e => e.feature === 'sibling-rename-collision');
      expect(collisions).toHaveLength(2);
    });

    it('is a no-op when siblings share the same param name', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/u/{id}/a': { get: { parameters: [{ in: 'path', name: 'id' }], responses: { '200': { description: 'ok' } } } },
          '/u/{id}/b': { get: { parameters: [{ in: 'path', name: 'id' }], responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      sanitizeNames(spec, diag);
      expect(diag.entries.filter(e => e.feature === 'sibling-path-param-conflict').length).toBe(0);
      expect(diag.entries.filter(e => e.feature === 'sibling-rename-collision').length).toBe(0);
    });

    it('treats {proxy+} as its own distinct param name', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/fs/{proxy+}': { get: { parameters: [{ in: 'path', name: 'proxy+' }], responses: { '200': { description: 'ok' } } } },
          '/fs/{name}':   { get: { parameters: [{ in: 'path', name: 'name' }], responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      const result = sanitizeNames(spec, diag);
      // Frequency tie (1–1), lexicographic tiebreak: '/fs/{name}' < '/fs/{proxy+}' so 'name' wins.
      const paths = Object.keys(result.paths);
      expect(paths).toContain('/fs/{name}');
      expect(paths.filter(p => p.includes('{proxy+}')).length).toBe(0);
    });

    it('updates operation-level path parameter names during rename', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/x/{winner}/y': { get: { parameters: [{ in: 'path', name: 'winner' }], responses: { '200': { description: 'ok' } } } },
          '/x/{winner}/z': { get: { parameters: [{ in: 'path', name: 'winner' }], responses: { '200': { description: 'ok' } } } },
          '/x/{loser}/q':  {
            get:  { parameters: [{ in: 'path', name: 'loser' }, { in: 'query', name: 'q' }], responses: { '200': { description: 'ok' } } },
            post: { parameters: [{ in: 'path', name: 'loser' }], responses: { '200': { description: 'ok' } } },
          },
        },
      };
      const diag = createDiagnostics();
      const result = sanitizeNames(spec, diag);
      const renamedPath = result.paths['/x/{winner}/q'];
      expect(renamedPath).toBeDefined();
      expect(renamedPath.get.parameters.find((p: any) => p.in === 'path').name).toBe('winner');
      expect(renamedPath.get.parameters.find((p: any) => p.in === 'query').name).toBe('q');
      expect(renamedPath.post.parameters[0].name).toBe('winner');
    });
  });

  it('drops path key with ? suffix when sibling base path exists', () => {
    const spec: any = {
      openapi: '3.0.0',
      paths: {
        '/foo': { get: { responses: { '200': { description: 'ok' } } } },
        '/foo?view=all': { get: { responses: { '200': { description: 'ok' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(Object.keys(result.paths)).toEqual(['/foo']);
    const breaking = diag.entries.find(e => e.feature === 'query-in-path-key' && e.action === 'removed');
    expect(breaking).toBeDefined();
    expect(breaking!.level).toBe('breaking');
  });

  it('renames path key with ? suffix when no sibling exists', () => {
    const spec: any = {
      openapi: '3.0.0',
      paths: {
        '/bar?tag=x': { get: { responses: { '200': { description: 'ok' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = sanitizeNames(spec, diag);
    expect(Object.keys(result.paths)).toEqual(['/bar']);
    const breaking = diag.entries.find(e => e.feature === 'query-in-path-key' && e.action === 'converted');
    expect(breaking).toBeDefined();
    expect(breaking!.level).toBe('breaking');
  });

  describe('path-drop diagnostic levels', () => {
    it('emits breaking for embedded-path-param', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/x/prefix-{name}.json': { get: { responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      sanitizeNames(spec, diag);
      const entries = diag.entries.filter(e => e.feature === 'embedded-path-param');
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('breaking');
    });

    it('emits breaking for invalid-path-chars', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/x/has@bad/y': { get: { responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      sanitizeNames(spec, diag);
      const entries = diag.entries.filter(e => e.feature === 'invalid-path-chars');
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('breaking');
    });

    it('emits info for empty-path', () => {
      const spec = {
        openapi: '3.0.0',
        paths: {
          '/no-ops': {},
          '/with-ops': { get: { responses: { '200': { description: 'ok' } } } },
        },
      };
      const diag = createDiagnostics();
      sanitizeNames(spec, diag);
      const entries = diag.entries.filter(e => e.feature === 'empty-path');
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('info');
    });
  });
});
