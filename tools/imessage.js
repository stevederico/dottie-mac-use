/**
 * iMessage tools — send and read messages via Messages.app.
 */

import path from 'path';
import os from 'os';
import { logToolUse, runCommandSafe, confirmTool, escapeAppleScript, runAppleScript, tagDomain } from './shared.js';
import { createTool } from './shared.js';

export const imessageTools = tagDomain([
  createTool({
    name: 'mac_imessage_send',
    description: 'Send a text message.',
    requiresConfirmation: true,
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Contact name or phone number (e.g., "John Smith", "Mom", "+1234567890")'
        },
        message: {
          type: 'string',
          description: 'The message content to send'
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to confirm sending the message'
        },
      },
      required: ['recipient'],
    },
    execute: async (input, signal, context) => {
      // message is not in `required`, so guard before dereferencing it
      if (!input.message) {
        return `No message provided. Please include the message content to send to ${input.recipient}.`;
      }

      // Require confirmation before sending. The dialog's Confirm button — not
      // the LLM — re-calls this tool with confirmed:true (confirmed is stripped
      // from LLM input by _internalParams), so the model cannot self-confirm.
      if (!input.confirmed) {
        const preview = input.message.length > 100 ? input.message.substring(0, 100) + '...' : input.message;
        return confirmTool({
          toolName: 'mac_imessage_send',
          input: { recipient: input.recipient, message: input.message },
          title: `Send iMessage to ${input.recipient}?`,
          message: preview,
          confirmLabel: 'Send',
        });
      }

      try {
        // Escape message for AppleScript
        const escapedMessage = escapeAppleScript(input.message);

        // Check if recipient looks like a phone number
        const isPhoneNumber = /^[\d\s\-\+\(\)]+$/.test(input.recipient.trim());

        let targetAddress = input.recipient;

        if (!isPhoneNumber) {
          // Look up contact's phone number
          const escapedRecipient = escapeAppleScript(input.recipient);
          const lookupScript = `
            tell application "Contacts"
              try
                set targetPerson to first person whose name contains "${escapedRecipient}"
                set phoneList to phones of targetPerson
                if (count of phoneList) > 0 then
                  return value of first item of phoneList
                else
                  return "NO_PHONE"
                end if
              on error
                return "NOT_FOUND"
              end try
            end tell
          `;

          const phoneResult = await runAppleScript(lookupScript);

          if (phoneResult.trim() === 'NOT_FOUND') {
            const result = `Contact "${input.recipient}" not found in your address book.`;
            logToolUse('mac_imessage_send', { recipient: input.recipient, message: '[redacted]' }, result);
            return result;
          }

          if (phoneResult.trim() === 'NO_PHONE') {
            const result = `Contact "${input.recipient}" has no phone number.`;
            logToolUse('mac_imessage_send', { recipient: input.recipient, message: '[redacted]' }, result);
            return result;
          }

          targetAddress = phoneResult.trim();
        }

        // Send the message via Messages.app
        const escapedTargetAddress = escapeAppleScript(targetAddress);
        const sendScript = `
          tell application "Messages"
            set targetService to 1st account whose service type = iMessage
            set targetBuddy to participant "${escapedTargetAddress}" of targetService
            send "${escapedMessage}" to targetBuddy
          end tell
        `;

        await runAppleScript(sendScript);

        const result = `Message sent to ${input.recipient}.`;
        logToolUse('mac_imessage_send', { recipient: input.recipient, message: '[redacted]' }, result);
        return result;
      } catch (error) {
        // Try alternative method using buddy by phone number
        try {
          const escapedAltMessage = escapeAppleScript(input.message);
          const escapedAltRecipient = escapeAppleScript(input.recipient);
          const altScript = `
            tell application "Messages"
              send "${escapedAltMessage}" to buddy "${escapedAltRecipient}" of (1st account whose service type = iMessage)
            end tell
          `;
          await runAppleScript(altScript);

          const result = `Message sent to ${input.recipient}.`;
          logToolUse('mac_imessage_send', { recipient: input.recipient, message: '[redacted]' }, result);
          return result;
        } catch (altError) {
          const result = `Failed to send message: ${error.message}. Make sure Messages.app is set up and the recipient is valid.`;
          logToolUse('mac_imessage_send', { recipient: input.recipient, message: '[redacted]' }, result);
          return result;
        }
      }
    },
  }),

  createTool({
    name: 'mac_imessage_read',
    description: 'Read recent messages from a contact or all recent messages. Use this when the user says "read my messages", "what did [name] say", "check messages from [name]", "any new messages?", or "read texts".',
    parameters: {
      type: 'object',
      properties: {
        contact: {
          type: 'string',
          description: 'Optional: Contact name to filter messages from (e.g., "John Smith", "Mom"). Leave empty for all recent messages.'
        },
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (default: 10, max: 50)'
        },
      },
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        const limit = Math.min(input.limit || 10, 50);

        // Query the Messages database directly (read-only)
        // Messages are stored in ~/Library/Messages/chat.db
        // Resolve to an absolute path: execFile does not run a shell, so the
        // `~` shorthand would not be expanded.
        const dbPath = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

        let query;
        if (input.contact) {
          // Search for messages from a specific contact
          const contactSearch = input.contact.replace(/'/g, "''");
          // Filter on the handle id (phone/email) only. A prior version OR'd in
          // a subquery that selected a nonexistent `value` column from
          // message_attachment_join — that made sqlite error on EVERY
          // contact-scoped read, which fell through to the AppleScript fallback
          // below and silently returned *everyone's* recent messages.
          query = `
            SELECT
              datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as time,
              CASE WHEN m.is_from_me = 1 THEN 'Me' ELSE COALESCE(h.id, 'Unknown') END as sender,
              m.text
            FROM message m
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.text IS NOT NULL AND m.text != ''
              AND h.id LIKE '%${contactSearch}%'
            ORDER BY m.date DESC
            LIMIT ${limit}
          `;
        } else {
          // Get all recent messages
          query = `
            SELECT
              datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as time,
              CASE WHEN m.is_from_me = 1 THEN 'Me' ELSE COALESCE(h.id, 'Unknown') END as sender,
              m.text
            FROM message m
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.text IS NOT NULL AND m.text != ''
            ORDER BY m.date DESC
            LIMIT ${limit}
          `;
        }

        // Invoke sqlite3 via execFile (no shell): shell metacharacters such as
        // $(), backticks, ; | & in the contact filter can never be interpreted.
        // The contact value is still SQL-escaped (single quotes doubled) above
        // because it is embedded in a SQL string literal.
        const result = await runCommandSafe('sqlite3', ['-header', '-column', dbPath, query.replace(/\n/g, ' ')]);

        if (!result || result.trim() === '') {
          const noMsgResult = input.contact
            ? `No recent messages found from "${input.contact}".`
            : 'No recent messages found.';
          logToolUse('mac_imessage_read', input, noMsgResult);
          return noMsgResult;
        }

        const formattedResult = input.contact
          ? `Recent messages with ${input.contact}:\n${result}`
          : `Recent messages:\n${result}`;

        logToolUse('mac_imessage_read', input, `Retrieved ${limit} messages`);
        return formattedResult;
      } catch (error) {
        // When a specific contact was requested we must NOT fall back to the
        // all-chats AppleScript path — that would leak unrelated people's
        // messages (the original privacy bug). Surface the error instead.
        if (input.contact) {
          const errorResult = `Couldn't read messages from "${input.contact}": ${error.message}. You may need to grant Full Disk Access to Dottie in System Settings > Privacy & Security.`;
          logToolUse('mac_imessage_read', input, errorResult);
          return errorResult;
        }
        // Fallback: Try AppleScript method (more limited) — only for the
        // unfiltered "recent messages" case.
        try {
          const asScript = `
            tell application "Messages"
              set recentChats to (chats 1 through ${Math.min(input.limit || 5, 10)})
              set chatList to {}
              repeat with c in recentChats
                try
                  set chatName to name of c
                  set lastMsg to text of last item of messages of c
                  set end of chatList to chatName & ": " & lastMsg
                end try
              end repeat
              set AppleScript's text item delimiters to "\\n"
              return chatList as text
            end tell
          `;
          const asResult = await runAppleScript(asScript);

          const formattedResult = `Recent messages:\n${asResult}`;
          logToolUse('mac_imessage_read', input, 'Retrieved via AppleScript');
          return formattedResult;
        } catch (asError) {
          const errorResult = `Failed to read messages: ${error.message}. You may need to grant Full Disk Access to the terminal/app in System Settings > Privacy & Security.`;
          logToolUse('mac_imessage_read', input, errorResult);
          return errorResult;
        }
      }
    },
  }),

  createTool({
    name: 'mac_imessage_reply',
    description: 'Reply to the most recent message in a conversation. Use this when the user says "reply to that", "respond to that message", "reply saying...", or "tell them...". Gets the most recent chat and sends a reply.',
    requiresConfirmation: true,
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The reply message content'
        },
        contact: {
          type: 'string',
          description: 'Optional: specific contact to reply to. If omitted, replies to most recent conversation.'
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to confirm sending the reply'
        },
      },
      required: ['message'],
    },
    execute: async (input, signal, context) => {
      // Require confirmation before sending (see mac_imessage_send for why this
      // routes through confirmTool rather than a plain re-call prompt).
      if (!input.confirmed) {
        const preview = input.message.length > 100 ? input.message.substring(0, 100) + '...' : input.message;
        const target = input.contact || 'most recent conversation';
        return confirmTool({
          toolName: 'mac_imessage_reply',
          input: { message: input.message, contact: input.contact },
          title: `Reply to ${target}?`,
          message: preview,
          confirmLabel: 'Send',
        });
      }

      try {
        const escapedMessage = escapeAppleScript(input.message);

        // Get the most recent chat participant and reply
        const escapedContact = input.contact ? escapeAppleScript(input.contact) : '';
        const replyScript = input.contact
          ? `
            tell application "Messages"
              set targetChat to first chat whose name contains "${escapedContact}"
              send "${escapedMessage}" to targetChat
              return "Reply sent to " & name of targetChat
            end tell
          `
          : `
            tell application "Messages"
              set recentChat to first chat
              send "${escapedMessage}" to recentChat
              return "Reply sent to " & name of recentChat
            end tell
          `;

        const result = await runAppleScript(replyScript);
        logToolUse('mac_imessage_reply', { message: '[redacted]', contact: input.contact }, result);
        return result;
      } catch (error) {
        const result = `Failed to send reply: ${error.message}`;
        logToolUse('mac_imessage_reply', { message: '[redacted]', contact: input.contact }, result);
        return result;
      }
    },
  }),
], 'comms');
