/**
 * Phone tools — make FaceTime Audio calls via macOS.
 */

import { runCommandSafe, escapeAppleScript as escapeAS, runAppleScript, tagDomain } from './shared.js';
import { createTool } from './shared.js';

/**
 * Escape a value for safe interpolation inside an AppleScript string literal.
 * Aliased re-export of the shared escapeAppleScript helper — the single audited
 * home for the escape chain. Prevents AppleScript injection: a Contacts value
 * like
 *   x" & (do shell script "...") & "
 * would otherwise close the `open location "facetime-audio://..."` literal and
 * run arbitrary AppleScript. The digit-only cleaning (cleanNumber) does not
 * strip quotes, so the contact value must be escaped before it reaches osascript.
 * Imported under the local name `escapeAS` so call sites here stay unchanged and
 * re-exported under the same name for phone.test.js's `{ escapeAS }` import.
 */
export { escapeAS };

/**
 * Build the `open location` AppleScript line for a FaceTime call. The cleaned
 * destination is escaped so no quote/backslash can break out of the string
 * literal. Exported for regression testing of the injection-safe construction.
 * @param {string} scheme  'facetime-audio' or 'facetime'
 * @param {string} dest    cleaned phone number or contact handle
 * @returns {string}
 */
export function buildFaceTimeScript(scheme, dest) {
  return `open location "${scheme}://${escapeAS(dest)}"`;
}

export const phoneTools = tagDomain([
  createTool({
    name: 'facetime_audio_call',
    description: 'Make a FaceTime Audio call to a contact. Looks up the contact by name and initiates a call. Use this when the user says "call [name]", "phone [name]", "FaceTime [name]", or "call mom/dad/etc".',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Contact name to call (e.g., "John Smith", "Mom", "Dr. Wilson")'
        },
      },
      required: ['name'],
    },
    execute: async (input, signal, context) => {
      try {
        // First, look up the contact's phone number
        const lookupScript = `
          tell application "Contacts"
            set targetPerson to first person whose name contains "${escapeAS(input.name)}"
            set phoneList to phones of targetPerson
            if (count of phoneList) > 0 then
              return value of first item of phoneList
            else
              return "NO_PHONE"
            end if
          end tell
        `;

        const phoneNumber = await runAppleScript(lookupScript);

        if (!phoneNumber || phoneNumber.trim() === 'NO_PHONE') {
          const result = `Could not find a phone number for "${input.name}". Make sure the contact exists and has a phone number.`;
          return result;
        }

        // Clean the phone number (remove spaces, dashes, parentheses)
        const cleanNumber = phoneNumber.trim().replace(/[\s\-\(\)]/g, '');

        // Initiate FaceTime Audio call. Run via execFile (no shell) so the
        // cleaned number is never shell-evaluated, and escape it so a stray
        // quote in a Contacts value can't break out of the AppleScript literal.
        const callScript = buildFaceTimeScript('facetime-audio', cleanNumber);

        await runCommandSafe('osascript', ['-e', callScript]);

        const result = `Calling ${input.name} via FaceTime Audio...`;
        return result;
      } catch (error) {
        if (error.message.includes("Can't get person")) {
          const result = `Contact "${input.name}" not found in your address book.`;
          return result;
        }
        const result = `Failed to make call: ${error.message}`;
        return result;
      }
    },
  }),
  createTool({
    name: 'facetime_video_call',
    description: 'Make a FaceTime Video call to a contact. Use this when the user says "video call [name]", "FaceTime video [name]".',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Contact name to video call (e.g., "John Smith", "Mom")'
        },
      },
      required: ['name'],
    },
    execute: async (input, signal, context) => {
      try {
        // Look up the contact's phone number or email
        const lookupScript = `
          tell application "Contacts"
            set targetPerson to first person whose name contains "${escapeAS(input.name)}"
            set phoneList to phones of targetPerson
            set emailList to emails of targetPerson
            if (count of phoneList) > 0 then
              return value of first item of phoneList
            else if (count of emailList) > 0 then
              return value of first item of emailList
            else
              return "NO_CONTACT"
            end if
          end tell
        `;

        const contact = await runAppleScript(lookupScript);

        if (!contact || contact.trim() === 'NO_CONTACT') {
          const result = `Could not find contact info for "${input.name}".`;
          return result;
        }

        // Clean the contact (phone or email)
        const cleanContact = contact.trim().replace(/[\s\-\(\)]/g, '');

        // Initiate FaceTime Video call. Run via execFile (no shell) so the
        // cleaned contact is never shell-evaluated, and escape it so a stray
        // quote in a Contacts value can't break out of the AppleScript literal.
        await runCommandSafe('osascript', ['-e', buildFaceTimeScript('facetime', cleanContact)]);

        const result = `Starting FaceTime video call with ${input.name}...`;
        return result;
      } catch (error) {
        if (error.message.includes("Can't get person")) {
          const result = `Contact "${input.name}" not found.`;
          return result;
        }
        const result = `Failed to start video call: ${error.message}`;
        return result;
      }
    },
  }),
], 'comms');
