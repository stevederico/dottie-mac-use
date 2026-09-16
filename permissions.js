/**
 * dottie-mac-use permission scopes — package-owned (standalone).
 * Gateway re-exports from tool_config.js for the agent loop.
 */

export const TOOL_PERMISSIONS = {
  'calendar.read': {
    tools: ['calendar_list', 'calendar_create'],
    description: 'Allow agent to read your calendar events',
    defaultEnabled: false,
  },
  'calendar.destructive': {
    tools: ['calendar_update', 'calendar_delete'],
    description: 'Allow agent to modify or delete calendar events',
    defaultEnabled: false,
  },
  'reminders.read': {
    tools: ['reminder_list', 'reminder_create'],
    description: 'Allow agent to read your reminders',
    defaultEnabled: false,
  },
  'reminders.destructive': {
    tools: ['reminder_update', 'reminder_delete'],
    description: 'Allow agent to modify or delete reminders',
    defaultEnabled: false,
  },
  'contacts.read': {
    tools: ['contacts_list', 'contacts_get'],
    description: 'Allow agent to read your contacts',
    defaultEnabled: false,
  },
  'mail.read': {
    tools: ['mail_list', 'mail_read'],
    description: 'Allow agent to read your emails',
    defaultEnabled: false,
  },
  'mail.send': {
    tools: ['mail_send'],
    description: 'Allow agent to send emails on your behalf',
    defaultEnabled: false,
  },
  'notes.read': {
    tools: ['notes_list', 'notes_read'],
    description: 'Allow agent to read your notes',
    defaultEnabled: false,
  },
  'notes.write': {
    tools: ['notes_create'],
    description: 'Allow agent to create notes',
    defaultEnabled: false,
  },
  'safari.read': {
    tools: ['safari_tabs'],
    description: 'Allow agent to see your open Safari tabs',
    defaultEnabled: false,
  },
  'safari.control': {
    tools: ['safari_open_url', 'open_url', 'hub_open'],
    description: 'Allow agent to open URLs in Safari, your default browser, or Grok Hub WebViews',
    defaultEnabled: true,
  },
  'files.read': {
    tools: ['files_recent', 'files_search', 'files_tags'],
    description: 'Allow agent to search and access your files',
    defaultEnabled: false,
  },
  'music.read': {
    tools: ['music_play'],
    description: 'Allow agent to play music (Spotify)',
    defaultEnabled: false,
  },
  'screenshot': {
    tools: ['screenshot', 'screenshot_and_analyze'],
    description: 'Allow agent to capture and analyze your screen',
    defaultEnabled: false,
  },
  'phone.call': {
    tools: ['facetime_audio_call', 'facetime_video_call'],
    description: 'Allow agent to make FaceTime audio and video calls',
    defaultEnabled: false,
  },
  'messages.read': {
    tools: ['imessage_read'],
    description: 'Allow agent to read your iMessages',
    defaultEnabled: false,
  },
  'messages.send': {
    tools: ['imessage_send', 'imessage_reply'],
    description: 'Allow agent to send iMessages on your behalf',
    defaultEnabled: false,
  },
  'accessibility.read': {
    tools: ['ax_apps', 'ax_tree', 'ax_focused', 'ax_read', 'ax_wait_for'],
    description: 'Allow agent to read UI elements of other apps',
    defaultEnabled: false,
  },
  'accessibility.execute': {
    tools: ['ax_click', 'screen_click', 'ax_fill', 'ax_press', 'ax_menu', 'ax_scroll', 'ax_set_value', 'ax_select', 'ax_show_menu', 'safari_click', 'safari_fill',
            'mouse_move', 'mouse_click', 'mouse_drag', 'keyboard_type', 'key_event', 'get_selected_text', 'type_text_at_cursor'],
    description: 'Allow agent to click, type, and control other apps',
    defaultEnabled: false,
  },
  'clipboard.read': {
    tools: ['get_clipboard', 'get_selected_text'],
    description: 'Allow agent to read your clipboard and selected text',
    defaultEnabled: false,
  },
};

let _dbPermissionsFn = null;

export function setPermissionReader(fn) {
  _dbPermissionsFn = fn;
}

export function getToolsForPermission(permission) {
  return TOOL_PERMISSIONS[permission]?.tools || [];
}

export function isScopeGranted(scope) {
  const cfg = TOOL_PERMISSIONS[scope];
  if (!cfg) return false;
  const perms = _dbPermissionsFn ? (_dbPermissionsFn() || {}) : {};
  return perms[scope] ?? cfg.defaultEnabled;
}

export function blockedToolNames(permissions) {
  const perms = permissions || {};
  const blocked = new Set();
  for (const [permKey, permConfig] of Object.entries(TOOL_PERMISSIONS)) {
    const isGranted = perms[permKey] ?? permConfig.defaultEnabled;
    if (!isGranted) {
      permConfig.tools.forEach(toolName => blocked.add(toolName));
    }
  }
  return blocked;
}

/** Resolve explicit map or live DB reader (empty object if neither). */
export function effectivePermissions(permissions) {
  if (permissions && Object.keys(permissions).length > 0) return permissions;
  return _dbPermissionsFn ? (_dbPermissionsFn() || {}) : {};
}

export function findScopeForTool(toolName) {
  for (const [permKey, permConfig] of Object.entries(TOOL_PERMISSIONS)) {
    if (permConfig.tools.includes(toolName)) return permKey;
  }
  return null;
}
