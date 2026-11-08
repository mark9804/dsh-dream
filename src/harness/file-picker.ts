import { isAbsolute } from 'node:path';
import { SettingsFailure } from '../settings/contracts.js';

// AppKit via the system JXA host. Fixed source, no path/source interpolation.
// The Edit menu keeps Cmd+V / Go to Folder available, including hidden paths.
export const MAC_FILE_PANEL = `
ObjC.import('AppKit');
function run() {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var menu = $.NSMenu.alloc.init;
  menu.addItem($.NSMenuItem.alloc.init);
  var edit = $.NSMenu.alloc.initWithTitle('Edit');
  var item = $.NSMenuItem.alloc.init;
  item.submenu = edit;
  menu.addItem(item);
  [['Undo', 'undo:', 'z'], ['Cut', 'cut:', 'x'], ['Copy', 'copy:', 'c'], ['Paste', 'paste:', 'v'], ['Select All', 'selectAll:', 'a']].forEach(function(command) {
    edit.addItemWithTitleActionKeyEquivalent(command[0], command[1], command[2]);
  });
  app.mainMenu = menu;
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = true;
  panel.canChooseDirectories = false;
  panel.canCreateDirectories = false;
  panel.allowsMultipleSelection = false;
  panel.showsHiddenFiles = true;
  panel.message = 'DSH-Dream — 选择人格文件 / Choose a persona file';
  $.NSOperationQueue.mainQueue.addOperationWithBlock(function() { app.activateIgnoringOtherApps(true); });
  if (panel.runModal !== $.NSModalResponseOK || panel.URLs.count < 1) return '';
  return ObjC.unwrap(panel.URLs.objectAtIndex(0).path);
}`;
interface NativeCommand {
  done: Promise<{ exitCode: number | null; signal: string | null }>;
  collected: { stdout?: { readFrom(offset: number): { text: string; lossy: boolean } } };
  terminate(): void;
}
interface PickerContext { get(name: string): unknown }
interface Subprocess { spawn(spec: { argv: readonly string[]; cwd: string; stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }; graceMs: number; signal: AbortSignal }): NativeCommand }

/** Owner-only settings action. A native directory capability is the Host's
 * evidence that this deployment can show OS UI. No dialogs at plugin startup,
 * no model tool, shell interpolation, file uploads or file-content reads. */
export function createPersonaFilePicker(ctx: PickerContext, platform = process.platform) {
  const stop = new AbortController();
  const pending = new Set<Promise<string | null>>();
  const available = () => platform === 'darwin'
    && (ctx.get('directoryPicker') as { capability(): { kind: string } } | undefined)?.capability().kind === 'native'
    && typeof (ctx.get('subprocess') as Subprocess | undefined)?.spawn === 'function';
  async function choose(signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    if (!available()) throw new SettingsFailure('UNAVAILABLE', 'Native persona file selection is currently available on local macOS only; enter the absolute Host file path instead');
    const lifetime = AbortSignal.any([signal, stop.signal]); lifetime.throwIfAborted();
    const handle = (ctx.get('subprocess') as Subprocess).spawn({
      argv: ['/usr/bin/osascript', '-l', 'JavaScript', '-e', MAC_FILE_PANEL], cwd: '/',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16384 }, stderr: { maxBytes: 16384 } }, graceMs: 500, signal: lifetime,
    });
    const cancel = () => handle.terminate(); lifetime.addEventListener('abort', cancel, { once: true });
    try {
      if (lifetime.aborted) cancel();
      const result = await handle.done; lifetime.throwIfAborted();
      if (result.exitCode !== 0 || result.signal !== null) throw new SettingsFailure('UNAVAILABLE', 'The system file chooser did not complete; the draft is unchanged');
      const output = handle.collected.stdout?.readFrom(0);
      if (!output || output.lossy) throw new SettingsFailure('UNAVAILABLE', 'System file chooser output is unavailable or too large');
      const path = output.text.replace(/\r?\n$/, '');
      if (!path) return null;
      if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new SettingsFailure('UNAVAILABLE', 'System file chooser returned an unsupported path');
      return path;
    } finally { lifetime.removeEventListener('abort', cancel); }
  }
  return { available, pick(signal: AbortSignal) {
    if (pending.size) return Promise.reject(new SettingsFailure('UNAVAILABLE', 'A persona file chooser is already open'));
    const work = choose(signal); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }, async dispose() { stop.abort(new Error('Persona file picker disposed')); await Promise.allSettled([...pending]); } };
}
