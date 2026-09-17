/**
 * dottie-mac-use permission scopes — package-owned (standalone).
 * Gateway re-exports from tool_config.js for the agent loop.
 */

export const TOOL_PERMISSIONS = {
  'calendar.read': {
    tools: ['mac_calendar_list', 'mac_calendar_create'],
    description: 'Allow agent to read your calendar events',
    defaultEnabled: false,
  },
  'calendar.destructive': {
    tools: ['mac_calendar_update', 'mac_calendar_delete'],
    description: 'Allow agent to modify or delete calendar events',
    defaultEnabled: false,
  },
  'reminders.read': {
    tools: ['mac_reminder_list', 'mac_reminder_create'],
    description: 'Allow agent to read your reminders',
    defaultEnabled: false,
  },
  'reminders.destructive': {
    tools: ['mac_reminder_update', 'mac_reminder_delete'],
    description: 'Allow agent to modify or delete reminders',
    defaultEnabled: false,
  },
  'contacts.read': {
    tools: ['mac_contacts_list', 'mac_contacts_get'],
    description: 'Allow agent to read your contacts',
    defaultEnabled: false,
  },
  'mail.read': {
    tools: ['mac_mail_list', 'mac_mail_read'],
    description: 'Allow agent to read your emails',
    defaultEnabled: false,
  },
  'mail.send': {
    tools: ['mac_mail_send'],
    description: 'Allow agent to send emails on your behalf',
    defaultEnabled: false,
  },
  'notes.read': {
    tools: ['mac_notes_list', 'mac_notes_read'],
    description: 'Allow agent to read your notes',
    defaultEnabled: false,
  },
  'notes.write': {
    tools: ['mac_notes_create'],
    description: 'Allow agent to create notes',
    defaultEnabled: false,
  },
  'safari.read': {
    tools: ['mac_safari_tabs'],
    description: 'Allow agent to see your open Safari tabs',
    defaultEnabled: false,
  },
  'safari.control': {
    tools: ['mac_safari_open_url', 'mac_open_url', 'mac_hub_open'],
    description: 'Allow agent to open URLs in Safari, your default browser, or Grok Hub WebViews',
    defaultEnabled: true,
  },
  'files.read': {
    tools: ['mac_files_recent', 'mac_files_search', 'mac_files_tags'],
    description: 'Allow agent to search and access your files',
    defaultEnabled: false,
  },
  'music.read': {
    tools: ['mac_music_play'],
    description: 'Allow agent to play music (Spotify)',
    defaultEnabled: false,
  },
  'screenshot': {
    tools: ['mac_screenshot', 'mac_screenshot_and_analyze'],
    description: 'Allow agent to capture and analyze your screen',
    defaultEnabled: false,
  },
  'phone.call': {
    tools: ['mac_facetime_audio_call', 'mac_facetime_video_call'],
    description: 'Allow agent to make FaceTime audio and video calls',
    defaultEnabled: false,
  },
  'messages.read': {
    tools: ['mac_imessage_read'],
    description: 'Allow agent to read your iMessages',
    defaultEnabled: false,
  },
  'messages.send': {
    tools: ['mac_imessage_send', 'mac_imessage_reply'],
    description: 'Allow agent to send iMessages on your behalf',
    defaultEnabled: false,
  },
  'accessibility.read': {
    tools: ['mac_ax_apps', 'mac_ax_tree', 'mac_ax_focused', 'mac_ax_read', 'mac_ax_wait_for'],
    description: 'Allow agent to read UI elements of other apps',
    defaultEnabled: false,
  },
  'accessibility.execute': {
    tools: ['mac_ax_click', 'mac_screen_click', 'mac_ax_fill', 'mac_ax_press', 'mac_ax_menu', 'mac_ax_scroll', 'mac_ax_set_value', 'mac_ax_select', 'mac_ax_show_menu', 'mac_safari_click', 'mac_safari_fill',
            'mac_mouse_move', 'mac_mouse_click', 'mac_mouse_drag', 'mac_keyboard_type', 'mac_key_event', 'mac_get_selected_text', 'mac_type_text_at_cursor'],
    description: 'Allow agent to click, type, and control other apps',
    defaultEnabled: false,
  },
  'clipboard.read': {
    tools: ['mac_get_clipboard', 'mac_get_selected_text'],
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
