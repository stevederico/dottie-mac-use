/**
 * Notes tools — list, read, and create notes in macOS Notes.app.
 */

import { escapeAppleScript, listAppleScriptRecords, runAppleScript, tagDomain } from './shared.js';
import { createTool } from './shared.js';

export const notesTools = tagDomain([
  createTool({
    name: 'mac_notes_list',
    description: 'List notes.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Notes folder name (default: all folders)'
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 20)'
        },
      },
      required: [],
    },
    execute: async (input, signal, context) => {
      // Coerce, don't trust the schema: `limit` is interpolated raw into the
      // AppleScript below, and AppleScript can `do shell script`. Number()
      // turns a hostile string into NaN (inert text), never source.
      const limit = Math.min(Number(input.limit) || 20, 100);
      try {
        let script;
        if (input.folder) {
          script = `
            tell application "Notes"
              set noteList to {}
              set counter to 0
              set targetFolder to first folder whose name is "${escapeAppleScript(input.folder)}"
              repeat with n in notes of targetFolder
                if counter >= ${limit} then exit repeat
                set modDate to modification date of n
                set dateStr to (month of modDate as integer) & "/" & (day of modDate)
                set end of noteList to dateStr & " | " & (name of n)
                set counter to counter + 1
              end repeat
              set AppleScript's text item delimiters to "\\n"
              return noteList as text
            end tell
          `;
        } else {
          script = `
            tell application "Notes"
              set noteList to {}
              set counter to 0
              repeat with acct in accounts
                repeat with f in folders of acct
                  repeat with n in notes of f
                    if counter >= ${limit} then exit repeat
                    set modDate to modification date of n
                    set dateStr to (month of modDate as integer) & "/" & (day of modDate)
                    set folderName to name of f
                    set end of noteList to dateStr & " | " & folderName & " | " & (name of n)
                    set counter to counter + 1
                  end repeat
                  if counter >= ${limit} then exit repeat
                end repeat
                if counter >= ${limit} then exit repeat
              end repeat
              set AppleScript's text item delimiters to "\\n"
              if (count of noteList) > 0 then
                return noteList as text
              else
                return "No notes found"
              end if
            end tell
          `;
        }
        return await listAppleScriptRecords(script, (raw) => raw || 'No notes found');
      } catch (error) {
        const result = `Failed to list notes: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_notes_read',
    description: 'Read a note.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Note title to find (partial match)'
        },
      },
      required: ['name'],
    },
    execute: async (input, signal, context) => {
      try {
        const script = `
          tell application "Notes"
            set foundNote to missing value
            repeat with acct in accounts
              repeat with f in folders of acct
                repeat with n in notes of f
                  if name of n contains "${escapeAppleScript(input.name)}" then
                    set foundNote to n
                    exit repeat
                  end if
                end repeat
                if foundNote is not missing value then exit repeat
              end repeat
              if foundNote is not missing value then exit repeat
            end repeat

            if foundNote is missing value then
              return "Note not found: ${escapeAppleScript(input.name)}"
            end if

            set modDate to modification date of foundNote
            set dateStr to (month of modDate as integer) & "/" & (day of modDate) & "/" & (year of modDate)

            -- Get plain text body (strip HTML)
            set noteBody to plaintext of foundNote
            -- Truncate if too long
            if (length of noteBody) > 3000 then
              set noteBody to (text 1 thru 3000 of noteBody) & "... [truncated]"
            end if

            return "Title: " & (name of foundNote) & "\\nModified: " & dateStr & "\\n\\n" & noteBody
          end tell
        `;
        return await listAppleScriptRecords(script, (raw) => raw || 'Note not found');
      } catch (error) {
        const result = `Failed to read note: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_notes_create',
    description: 'Create a note.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Note title'
        },
        body: {
          type: 'string',
          description: 'Note content'
        },
        folder: {
          type: 'string',
          description: 'Folder name (default: Notes)'
        },
      },
      required: ['title', 'body'],
    },
    execute: async (input, signal, context) => {
      const folderName = input.folder || 'Notes';
      try {
        const script = `
          tell application "Notes"
            set targetFolder to missing value
            repeat with acct in accounts
              repeat with f in folders of acct
                if name of f is "${escapeAppleScript(folderName)}" then
                  set targetFolder to f
                  exit repeat
                end if
              end repeat
              if targetFolder is not missing value then exit repeat
            end repeat

            if targetFolder is missing value then
              -- Use default folder of first account
              set targetFolder to default folder of first account
            end if

            set noteBody to "<h1>${escapeAppleScript(input.title)}</h1><br>" & "${escapeAppleScript(input.body).replace(/\n/g, '<br>')}"
            tell targetFolder
              make new note with properties {body:noteBody}
            end tell

            return "Created note: ${escapeAppleScript(input.title)}"
          end tell
        `;
        await runAppleScript(script);
        const result = `Created note: "${input.title}" in ${folderName}`;
        return result;
      } catch (error) {
        const result = `Failed to create note: ${error.message}`;
        return result;
      }
    },
  }),
], 'info');
