/**
 * Contacts tools — list and get details from macOS Contacts.app.
 */

import { listAppleScriptRecords, escapeAppleScript, tagDomain } from './shared.js';
import { createTool } from './shared.js';

export const contactsTools = tagDomain([
  createTool({
    name: 'contacts_list',
    description: 'Search contacts.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Optional name to search for'
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
        if (input.search) {
          script = `
            tell application "Contacts"
              set matchingPeople to (every person whose name contains "${escapeAppleScript(input.search)}")
              set nameList to {}
              repeat with p in matchingPeople
                set end of nameList to name of p
              end repeat
              set AppleScript's text item delimiters to "\\n"
              return nameList as text
            end tell
          `;
        } else {
          script = `
            tell application "Contacts"
              set allPeople to every person
              set nameList to {}
              set counter to 0
              repeat with p in allPeople
                if counter >= ${limit} then exit repeat
                set end of nameList to name of p
                set counter to counter + 1
              end repeat
              set AppleScript's text item delimiters to "\\n"
              return nameList as text
            end tell
          `;
        }
        return await listAppleScriptRecords(script, (raw) => raw || 'No contacts found');
      } catch (error) {
        const result = `Failed to list contacts: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'contacts_get',
    description: 'Get contact details.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Contact name to look up'
        },
      },
      required: ['name'],
    },
    execute: async (input, signal, context) => {
      try {
        const script = `
          tell application "Contacts"
            set targetPerson to first person whose name contains "${escapeAppleScript(input.name)}"
            set contactInfo to "Name: " & (name of targetPerson)

            -- Get phones
            set phoneList to {}
            repeat with p in phones of targetPerson
              set end of phoneList to (label of p) & ": " & (value of p)
            end repeat
            if (count of phoneList) > 0 then
              set AppleScript's text item delimiters to ", "
              set contactInfo to contactInfo & "\\nPhones: " & (phoneList as text)
            end if

            -- Get emails
            set emailList to {}
            repeat with e in emails of targetPerson
              set end of emailList to (value of e)
            end repeat
            if (count of emailList) > 0 then
              set AppleScript's text item delimiters to ", "
              set contactInfo to contactInfo & "\\nEmails: " & (emailList as text)
            end if

            -- Get addresses
            set addressList to {}
            repeat with a in addresses of targetPerson
              set addrStr to ""
              try
                set addrStr to (street of a) & ", " & (city of a) & ", " & (state of a) & " " & (zip of a)
              end try
              if addrStr is not "" then set end of addressList to addrStr
            end repeat
            if (count of addressList) > 0 then
              set AppleScript's text item delimiters to "; "
              set contactInfo to contactInfo & "\\nAddresses: " & (addressList as text)
            end if

            -- Get company
            try
              set orgName to organization of targetPerson
              if orgName is not missing value then
                set contactInfo to contactInfo & "\\nCompany: " & orgName
              end if
            end try

            return contactInfo
          end tell
        `;
        return await listAppleScriptRecords(script, (raw) => raw || 'Contact not found');
      } catch (error) {
        if (error.message.includes("Can't get person")) {
          const result = `Contact "${input.name}" not found`;
          return result;
        }
        const result = `Failed to get contact: ${error.message}`;
        return result;
      }
    },
  }),
], 'comms');
