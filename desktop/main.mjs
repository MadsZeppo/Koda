import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
register();
const { startDesktopRun } = await import('../src/desktop/runner.ts');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
let window, active, selectedRepo, report;
const sessionsPath = () => join(app.getPath('userData'), 'sessions.json');
async function history() { try { return JSON.parse(await readFile(sessionsPath(), 'utf8')); } catch { return []; } }
function trusted(event) { if (event.sender !== window?.webContents) throw Error('Unknown renderer'); }
ipcMain.handle('history', event => { trusted(event); return history(); });
ipcMain.handle('folder', async event => {
  trusted(event);
  if (active) throw Error('Vent på den igangværende opgave');
  const choice = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
  if (!choice.canceled) selectedRepo = choice.filePaths[0];
  return selectedRepo;
});
ipcMain.handle('run', async (event, request) => {
  trusted(event);
  if (active) throw Error('En opgave kører allerede');
  if (!selectedRepo || request.repo !== selectedRepo) throw Error('Vælg først projektmappen');
  active = { starting: true };
  try {
    active = await startDesktopRun(request, root, join(app.getPath('home'), '.koda', 'runs'), text => window?.webContents.send('log', text), process.env.KODA_NODE_RUNTIME || 'node');
    const result = await active.done;
    report = result.output;
    const entries = await history();
    entries.push({ repo: request.repo, task: request.task, date: new Date().toISOString(), ...result });
    await mkdir(dirname(sessionsPath()), { recursive: true });
    await writeFile(sessionsPath(), JSON.stringify(entries.slice(-100)));
    return result;
  } finally { active = undefined; }
});
ipcMain.handle('report', event => { trusted(event); if (report) return shell.openPath(report); });
app.whenReady().then(() => {
  window = new BrowserWindow({ width: 1160, height: 820, minWidth: 850, minHeight: 600, title: 'Koda', backgroundColor: '#111217', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (active) { event.preventDefault(); dialog.showMessageBox(window, { message: 'Koda arbejder stadig. Vent på resultatet, før du lukker appen.', buttons: ['OK'] }); } });
  window.loadFile(join(here, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
