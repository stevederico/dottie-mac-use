/**
 * System control tools using AppleScript.
 *
 * Voice-assistant-like commands for:
 * - Dark mode toggle
 * - Do Not Disturb toggle
 * - Hide all apps
 * - Show desktop
 * - Type text at cursor
 * - Get frontmost browser URL
 */

import { runCommand, runCommandSafe, tagDomain } from './shared.js';
import { createTool } from './shared.js';

export const systemTools = tagDomain([
  createTool({
    name: 'mac_dark_mode_toggle',
    description: 'Toggle dark/light mode.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        await runCommandSafe('osascript', [
          '-e', 'tell app "System Events" to tell appearance preferences to set dark mode to not dark mode'
        ]);
        // Check current state after toggle
        const isDark = await runCommandSafe('osascript', [
          '-e', 'tell app "System Events" to tell appearance preferences to get dark mode'
        ]);
        return isDark.trim() === 'true' ? 'Switched to dark mode' : 'Switched to light mode';
      } catch (err) {
        return `Error toggling dark mode: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_do_not_disturb',
    description: 'Toggle Do Not Disturb.',
    parameters: {
      type: 'object',
      // No `enable` param: the underlying Shortcut only toggles and macOS has
      // no reliable scriptable Focus-state read, so an enable/disable flag could
      // only ever guess the resulting state — and would report the opposite of
      // reality on a mismatch. Always toggle, always report "toggled".
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        // Try using Shortcuts first (modern macOS Sonoma+)
        try {
          await runCommand('shortcuts run "Toggle Do Not Disturb"');
          return 'Do Not Disturb toggled';
        } catch {
          // Fallback: instruct user to create shortcut
          return 'Please create a Shortcut named "Toggle Do Not Disturb" that toggles Focus mode. Go to Shortcuts app > + > Add Action > "Set Focus" > toggle mode.';
        }
      } catch (err) {
        return `Error toggling Do Not Disturb: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_hide_all_apps',
    description: 'Hide all apps.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        await runCommandSafe('osascript', [
          '-e', 'tell application "System Events" to set visible of every process whose visible is true and name is not "Finder" to false'
        ]);
        return 'All apps hidden';
      } catch (err) {
        return `Error hiding apps: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_show_desktop',
    description: 'Show desktop.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        // Use Mission Control's Show Desktop gesture via key code
        // This simulates F11 which is typically mapped to Show Desktop
        await runCommandSafe('osascript', [
          '-e', 'tell application "System Events" to key code 103 using {command down, fn down}'
        ]);
        return 'Desktop shown';
      } catch (err) {
        return `Error showing desktop: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_get_frontmost_url',
    description: 'Get URL from frontmost browser tab.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        // Get frontmost app name
        const frontApp = await runCommandSafe('osascript', [
          '-e', 'tell application "System Events" to get name of first process whose frontmost is true'
        ]);
        const appName = frontApp.trim();

        let url = '';
        let script = '';

        switch (appName) {
          case 'Safari':
            script = 'tell application "Safari" to get URL of front document';
            break;
          case 'Google Chrome':
            script = 'tell application "Google Chrome" to get URL of active tab of front window';
            break;
          case 'Arc':
            script = 'tell application "Arc" to get URL of active tab of front window';
            break;
          case 'Brave Browser':
            script = 'tell application "Brave Browser" to get URL of active tab of front window';
            break;
          case 'Microsoft Edge':
            script = 'tell application "Microsoft Edge" to get URL of active tab of front window';
            break;
          case 'Firefox':
            // Firefox doesn't support AppleScript well, try alternate method
            script =
              'tell application "System Events" to tell process "Firefox" to get value of attribute "AXDocument" of window 1';
            break;
          default:
            return `Frontmost app "${appName}" is not a supported browser. Supported: Safari, Chrome, Arc, Brave, Edge, Firefox.`;
        }

        url = await runCommandSafe('osascript', ['-e', script]);
        return url.trim() || 'No URL found';
      } catch (err) {
        return `Error getting URL: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_lock_screen',
    description: 'Lock the screen.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        await runCommandSafe('osascript', [
          '-e', 'tell application "System Events" to keystroke "q" using {control down, command down}'
        ]);
        return 'Screen locked';
      } catch (err) {
        return `Error locking screen: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_sleep_display',
    description: 'Put display to sleep.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        await runCommand('pmset displaysleepnow');
        return 'Display sleeping';
      } catch (err) {
        return `Error sleeping display: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_system_sleep',
    description: 'Put computer to sleep.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        await runCommand('pmset sleepnow');
        return 'System sleeping';
      } catch (err) {
        return `Error sleeping system: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_wifi_toggle',
    description: 'Toggle Wi-Fi.',
    parameters: {
      type: 'object',
      properties: {
        enable: {
          type: 'boolean',
          description: 'true to enable, false to disable. Omit to toggle.',
        },
      },
    },
    execute: async (input, signal, context) => {
      try {
        const { enable } = input;

        // Get current Wi-Fi status
        const statusOutput = await runCommand('networksetup -getairportpower en0');
        const isCurrentlyOn = statusOutput.includes('On');

        // Determine desired state
        const shouldEnable = enable === undefined ? !isCurrentlyOn : enable;
        const action = shouldEnable ? 'on' : 'off';

        await runCommand(`networksetup -setairportpower en0 ${action}`);
        return shouldEnable ? 'Wi-Fi enabled' : 'Wi-Fi disabled';
      } catch (err) {
        return `Error toggling Wi-Fi: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_bluetooth_toggle',
    description: 'Toggle Bluetooth.',
    parameters: {
      type: 'object',
      properties: {
        enable: {
          type: 'boolean',
          description: 'true to enable, false to disable. Omit to toggle.',
        },
      },
    },
    execute: async (input, signal, context) => {
      try {
        const { enable } = input;

        // Check if blueutil is available (common Bluetooth CLI tool)
        try {
          await runCommand('which blueutil');
        } catch {
          return 'blueutil not installed. Install with: brew install blueutil';
        }

        // Get current status
        const statusOutput = await runCommand('blueutil -p');
        const isCurrentlyOn = statusOutput.trim() === '1';

        // Determine desired state
        const shouldEnable = enable === undefined ? !isCurrentlyOn : enable;
        const action = shouldEnable ? '1' : '0';

        await runCommand(`blueutil -p ${action}`);
        return shouldEnable ? 'Bluetooth enabled' : 'Bluetooth disabled';
      } catch (err) {
        return `Error toggling Bluetooth: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_get_system_info',
    description: 'Get system status.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        const info = {};

        // Dark mode
        const darkMode = await runCommandSafe('osascript', [
          '-e', 'tell app "System Events" to tell appearance preferences to get dark mode'
        ]);
        info.darkMode = darkMode.trim() === 'true';

        // Wi-Fi
        try {
          const wifi = await runCommand('networksetup -getairportpower en0');
          info.wifi = wifi.includes('On');
        } catch {
          info.wifi = 'unknown';
        }

        // Battery
        try {
          const battery = await runCommand('pmset -g batt');
          const match = battery.match(/(\d+)%/);
          info.battery = match ? `${match[1]}%` : 'unknown';
          info.charging = battery.includes('AC Power');
        } catch {
          info.battery = 'unknown';
        }

        // macOS version
        try {
          const version = await runCommand('sw_vers -productVersion');
          info.macOSVersion = version.trim();
        } catch {
          info.macOSVersion = 'unknown';
        }

        return JSON.stringify(info, null, 2);
      } catch (err) {
        return `Error getting system info: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_empty_trash',
    description: 'Empty Trash.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        await runCommandSafe('osascript', [
          '-e', 'tell application "Finder" to empty trash'
        ]);
        return 'Trash emptied';
      } catch (err) {
        return `Error emptying trash: ${err.message}`;
      }
    },
  }),
  createTool({
    name: 'mac_open_system_preferences',
    description: 'Open System Settings.',
    parameters: {
      type: 'object',
      properties: {
        pane: {
          type: 'string',
          description: 'Pane to open: general, appearance, wallpaper, dock, notifications, sound, privacy, network, bluetooth, displays, battery, keyboard, mouse, trackpad, accessibility, siri, spotlight, users, passwords, wifi, focus',
        },
      },
    },
    execute: async (input, signal, context) => {
      try {
        const { pane } = input;

        // Map friendly names to System Settings URLs (macOS Ventura+)
        const paneMap = {
          general: 'x-apple.systempreferences:com.apple.preference.general',
          appearance: 'x-apple.systempreferences:com.apple.Appearance-Settings.extension',
          wallpaper: 'x-apple.systempreferences:com.apple.Wallpaper-Settings.extension',
          dock: 'x-apple.systempreferences:com.apple.Desktop-Settings.extension',
          notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
          sound: 'x-apple.systempreferences:com.apple.preference.sound',
          privacy: 'x-apple.systempreferences:com.apple.preference.security',
          network: 'x-apple.systempreferences:com.apple.Network-Settings.extension',
          bluetooth: 'x-apple.systempreferences:com.apple.BluetoothSettings',
          displays: 'x-apple.systempreferences:com.apple.Displays-Settings.extension',
          battery: 'x-apple.systempreferences:com.apple.preference.battery',
          keyboard: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension',
          mouse: 'x-apple.systempreferences:com.apple.Mouse-Settings.extension',
          trackpad: 'x-apple.systempreferences:com.apple.Trackpad-Settings.extension',
          accessibility: 'x-apple.systempreferences:com.apple.preference.universalaccess',
          siri: 'x-apple.systempreferences:com.apple.Siri-Settings.extension',
          spotlight: 'x-apple.systempreferences:com.apple.Siri-Settings.extension',
          users: 'x-apple.systempreferences:com.apple.preferences.users',
          passwords: 'x-apple.systempreferences:com.apple.Passwords-Settings.extension',
          wifi: 'x-apple.systempreferences:com.apple.wifi-settings-extension',
          focus: 'x-apple.systempreferences:com.apple.Focus-Settings.extension',
        };

        const url = pane ? paneMap[pane.toLowerCase()] : null;

        if (url) {
          await runCommand(`open "${url}"`);
          return `Opened ${pane} settings`;
        } else if (!pane) {
          await runCommand('open "x-apple.systempreferences:"');
          return 'Opened System Settings';
        } else {
          return `Unknown pane "${pane}". Available: ${Object.keys(paneMap).join(', ')}`;
        }
      } catch (err) {
        return `Error opening System Settings: ${err.message}`;
      }
    },
  }),
], 'system');
