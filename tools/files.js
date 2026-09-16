/**
 * Files/Finder tools — recent files, search, and tag management.
 */

import { createTool } from './shared.js';
import { runCommandSafe, sanitizeShellArg, tagDomain } from './shared.js';

export const filesTools = tagDomain([
  createTool({
    name: 'files_recent',
    description: 'List recently opened files from Finder',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results (default: 20)'
        },
        type: {
          type: 'string',
          description: 'File type filter (e.g., "pdf", "jpg", "doc")'
        },
      },
      required: [],
    },
    execute: async (input, signal, context) => {
      const parsedLimit = Number.parseInt(input.limit, 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
      try {
        // Spotlight query is passed as a single argv expression — never shell-interpolated.
        let mdQuery = 'kMDItemLastUsedDate >= $time.today(-7)';
        if (input.type) {
          // The type is embedded inside the Spotlight query string (not a shell
          // arg), so strip characters that could break out of the quoted glob.
          mdQuery = `kMDItemLastUsedDate >= $time.today(-7) && kMDItemFSName == '*.${sanitizeShellArg(input.type)}'`;
        }
        const out = await runCommandSafe('mdfind', [mdQuery, '-0']);
        const paths = out.split('\0').filter(Boolean);
        if (paths.length === 0) {
          return 'No recent files found';
        }
        // Sort newest-first by mtime, then take `limit` — replaces the old
        // `ls -lt | head` shell pipeline. Files that vanished are skipped.
        const { promises: fs } = await import('node:fs');
        const stated = [];
        for (const p of paths) {
          try {
            const st = await fs.stat(p);
            stated.push({ path: p, mtime: st.mtimeMs });
          } catch {
            // path disappeared between mdfind and stat — ignore
          }
        }
        stated.sort((a, b) => b.mtime - a.mtime);
        return stated.slice(0, limit).map(f => f.path).join('\n') || 'No recent files found';
      } catch (error) {
        return `Failed to list recent files: ${error.message}`;
      }
    },
  }),

  createTool({
    name: 'files_search',
    description: 'Search for files.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (filename or content)'
        },
        folder: {
          type: 'string',
          description: 'Limit search to folder path (optional)'
        },
        type: {
          type: 'string',
          description: 'File type (e.g., "pdf", "image", "document")'
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 20)'
        },
      },
      required: ['query'],
    },
    execute: async (input, signal, context) => {
      const parsedLimit = Number.parseInt(input.limit, 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
      try {
        // The whole Spotlight expression is one argv element passed to mdfind —
        // it's never handed to a shell, so the interior double-quotes are part
        // of the query syntax, not shell quoting. sanitizeShellArg() still
        // strips backticks/$/quotes that could corrupt the query expression.
        let query = `"${sanitizeShellArg(input.query)}"`;

        // Add type filter
        if (input.type) {
          const typeMap = {
            'pdf': 'kMDItemContentType == "com.adobe.pdf"',
            'image': 'kMDItemContentTypeTree == "public.image"',
            'document': 'kMDItemContentTypeTree == "public.content"',
            'audio': 'kMDItemContentTypeTree == "public.audio"',
            'video': 'kMDItemContentTypeTree == "public.movie"',
          };
          if (typeMap[input.type]) {
            query = `${typeMap[input.type]} && ${query}`;
          } else {
            query = `kMDItemFSName == "*.${sanitizeShellArg(input.type)}" && ${query}`;
          }
        }

        const args = [];
        if (input.folder) {
          // Folder is a real filesystem path — passed as its own argv element.
          args.push('-onlyin', input.folder);
        }
        args.push(query);

        const out = await runCommandSafe('mdfind', args);
        const lines = out.split('\n').filter(Boolean).slice(0, limit);
        return lines.join('\n') || 'No files found';
      } catch (error) {
        return `Failed to search files: ${error.message}`;
      }
    },
  }),

  createTool({
    name: 'files_tags',
    description: 'Get or set Finder tags on a file',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path'
        },
        action: {
          type: 'string',
          description: '"get" to read tags, "add" to add tags, "remove" to remove tags'
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tag names (for add/remove)'
        },
      },
      required: ['path', 'action'],
    },
    execute: async (input, signal, context) => {
      try {
        if (input.action === 'get') {
          // path is an argv element — execFile, no shell interpolation.
          const tags = await runCommandSafe('mdls', ['-name', 'kMDItemUserTags', '-raw', input.path]);
          return tags === '(null)' ? 'No tags' : `Tags: ${tags}`;
        } else if (input.action === 'add' && input.tags) {
          const tagList = input.tags.split(',').map(t => t.trim());
          for (const tag of tagList) {
            // The plist value and path are passed as separate argv elements —
            // the tag is interpolated only into the plist XML, never a shell.
            const plist = `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>${tag}</string></array></plist>`;
            await runCommandSafe('xattr', ['-w', 'com.apple.metadata:_kMDItemUserTags', plist, input.path]);
          }
          return `Added tags: ${input.tags}`;
        } else if (input.action === 'remove') {
          // Was `... 2>/dev/null || true` under a shell; with execFile we
          // swallow the "no such attribute" failure in JS instead.
          try {
            await runCommandSafe('xattr', ['-d', 'com.apple.metadata:_kMDItemUserTags', input.path]);
          } catch {
            // attribute may not exist — treat as already removed
          }
          return 'Removed all tags';
        } else {
          return 'Invalid action. Use "get", "add", or "remove"';
        }
      } catch (error) {
        return `Failed to manage tags: ${error.message}`;
      }
    },
  }),
], 'info');
