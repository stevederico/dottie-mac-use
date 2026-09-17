/**
 * Mail tools — list, read, and send emails via macOS Mail.app.
 */

import { confirmTool, escapeAppleScript, listAppleScriptRecords, runAppleScript, tagDomain } from './shared.js';
import { createTool } from './shared.js';

export const mailTools = tagDomain([
  createTool({
    name: 'mac_mail_list',
    description: 'List recent emails.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        mailbox: {
          type: 'string',
          description: 'Mailbox name (default: INBOX)'
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 10)'
        },
        unread_only: {
          type: 'boolean',
          description: 'Only show unread messages'
        },
      },
      required: [],
    },
    execute: async (input, signal, context) => {
      // Coerce, don't trust the schema: `limit` is interpolated raw into the
      // AppleScript below, and AppleScript can `do shell script`. Number()
      // turns a hostile string into NaN (inert text), never source.
      const limit = Math.min(Number(input.limit) || 10, 100);
      const mailbox = escapeAppleScript(input.mailbox || 'INBOX');
      try {
        const script = `
          tell application "Mail"
            set msgList to {}
            set targetMailboxes to (every mailbox whose name is "${mailbox}")
            if (count of targetMailboxes) = 0 then
              -- Try inbox of each account
              repeat with acct in accounts
                try
                  set targetMailboxes to targetMailboxes & (inbox of acct)
                end try
              end repeat
            end if

            set counter to 0
            repeat with mbox in targetMailboxes
              set msgs to messages of mbox
              repeat with msg in msgs
                if counter >= ${limit} then exit repeat
                ${input.unread_only ? 'if read status of msg is false then' : ''}
                  set msgDate to date received of msg
                  set dateStr to (month of msgDate as integer) & "/" & (day of msgDate) & " " & (hours of msgDate) & ":" & text -2 thru -1 of ("0" & (minutes of msgDate))
                  set senderAddr to ""
                  try
                    set senderAddr to extract address from sender of msg
                  on error
                    set senderAddr to sender of msg
                  end try
                  set msgSubject to subject of msg
                  set readStatus to ""
                  if read status of msg is false then set readStatus to "[UNREAD] "
                  set end of msgList to readStatus & dateStr & " | " & senderAddr & " | " & msgSubject
                  set counter to counter + 1
                ${input.unread_only ? 'end if' : ''}
              end repeat
              if counter >= ${limit} then exit repeat
            end repeat

            set AppleScript's text item delimiters to "\\n"
            if (count of msgList) > 0 then
              return msgList as text
            else
              return "No messages found"
            end if
          end tell
        `;
        return await listAppleScriptRecords(script, (raw) => raw || 'No messages found');
      } catch (error) {
        const result = `Failed to list mail: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_mail_read',
    description: 'Read an email.',
    parameters: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Email subject to find (partial match)'
        },
      },
      required: ['subject'],
    },
    execute: async (input, signal, context) => {
      try {
        const script = `
          tell application "Mail"
            set foundMsg to missing value
            repeat with acct in accounts
              try
                set inboxMsgs to messages of inbox of acct
                repeat with msg in inboxMsgs
                  if subject of msg contains "${escapeAppleScript(input.subject)}" then
                    set foundMsg to msg
                    exit repeat
                  end if
                end repeat
              end try
              if foundMsg is not missing value then exit repeat
            end repeat

            if foundMsg is missing value then
              return "Email not found with subject: ${escapeAppleScript(input.subject)}"
            end if

            set msgDate to date received of foundMsg
            set dateStr to (month of msgDate as integer) & "/" & (day of msgDate) & "/" & (year of msgDate)
            set senderAddr to ""
            try
              set senderAddr to extract address from sender of foundMsg
            on error
              set senderAddr to sender of foundMsg
            end try

            set msgContent to content of foundMsg
            -- Truncate if too long
            if (length of msgContent) > 2000 then
              set msgContent to (text 1 thru 2000 of msgContent) & "... [truncated]"
            end if

            return "From: " & senderAddr & "\\nDate: " & dateStr & "\\nSubject: " & (subject of foundMsg) & "\\n\\n" & msgContent
          end tell
        `;
        return await listAppleScriptRecords(script, (raw) => raw || 'Email not found');
      } catch (error) {
        const result = `Failed to read email: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_mail_send',
    description: 'Send an email.',
    requiresPermission: 'mail.send',
    requiresConfirmation: true,
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address'
        },
        subject: {
          type: 'string',
          description: 'Email subject'
        },
        body: {
          type: 'string',
          description: 'Email body'
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to confirm sending'
        },
      },
      required: ['to'],
    },
    execute: async (input, signal, context) => {
      const subject = input.subject || '';
      const body = input.body || '';
      if (!input.confirmed) {
        // confirmed is stripped from LLM input (_internalParams); the dialog's
        // Send button re-calls this tool with confirmed:true. Without the
        // dialog the message could never actually be sent.
        const preview = `${body.substring(0, 100)}${body.length > 100 ? '...' : ''}`;
        return confirmTool({
          toolName: 'mac_mail_send',
          input: { to: input.to, subject: input.subject, body: input.body },
          title: `Send email to ${input.to}?`,
          message: `Subject: ${subject}${preview ? `\n${preview}` : ''}`,
          confirmLabel: 'Send',
        });
      }

      try {
        const script = `
          tell application "Mail"
            set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(subject)}", content:"${escapeAppleScript(body).replace(/\n/g, '\\n')}", visible:false}
            tell newMessage
              make new to recipient at end of to recipients with properties {address:"${escapeAppleScript(input.to)}"}
            end tell
            send newMessage
            return "Email sent"
          end tell
        `;
        await runAppleScript(script);
        const result = `Email sent to ${input.to}`;
        return result;
      } catch (error) {
        const result = `Failed to send email: ${error.message}`;
        return result;
      }
    },
  }),
], 'comms');
