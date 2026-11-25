import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_TABLE_GROUP_FILE_BYTES, parseTableGroupFile, type SaveTableGroupFileResult } from '../shared/table-group-transfer';

export async function saveTableGroupFile(text: string): Promise<SaveTableGroupFileResult> {
  parseTableGroupFile(text);
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showSaveDialog(window, {
    title: 'Export Groups', defaultPath: path.join(os.homedir(), 'Downloads', 'earthql-table-groups.json'),
    filters: [{ name: 'EarthQL Groups', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { status: 'dialog-cancelled' };
  await fs.writeFile(result.filePath, text, 'utf8');
  return { status: 'ok', path: result.filePath };
}

export async function readTableGroupFile(): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(window, {
    title: 'Import Groups', properties: ['openFile'], filters: [{ name: 'EarthQL Groups', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const file = await fs.open(result.filePaths[0], 'r');
  const buffer = Buffer.alloc(MAX_TABLE_GROUP_FILE_BYTES + 1);
  let length = 0;
  try {
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
  } finally { await file.close(); }
  if (length > MAX_TABLE_GROUP_FILE_BYTES) throw new Error('Group files must not exceed 1 MiB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  parseTableGroupFile(text);
  return text;
}
