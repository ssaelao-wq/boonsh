import { describe, expect, it } from 'vitest';
import { isLanPath, resolveLanIncomingDestination, resolveLanGDriveDestination } from '../lan';
import { sameFolder, transferQuestion } from '../dualPane';

describe('LAN file sharing helpers', () => {
  it('detects lan:// paths correctly', () => {
    expect(isLanPath('lan://mobile')).toBe(true);
    expect(isLanPath('lan://mobile/outgoing')).toBe(true);
    expect(isLanPath('lan://mobile/incoming')).toBe(true);
    expect(isLanPath('lan:')).toBe(true);
    expect(isLanPath('C:\\Work')).toBe(false);
    expect(isLanPath('gdrive://root')).toBe(false);
    expect(isLanPath(null)).toBe(false);
    expect(isLanPath('')).toBe(false);
  });

  it('formats dual-pane transfer questions for Mobile Drop', () => {
    const q1 = transferQuestion(['C:\\Work\\Report.docx'], 'lan://mobile', false);
    expect(q1).toBe('Copy "Report.docx" to\nMobile Drop?');

    const q2 = transferQuestion(['gdrive://doc123'], 'lan://mobile', false, ['Project Plan.gdoc']);
    expect(q2).toBe('Copy "Project Plan.gdoc" to\nMobile Drop?');

    const q3 = transferQuestion(['C:\\a.txt', 'C:\\b.txt'], 'lan://mobile', false);
    expect(q3).toBe('Copy 2 items to\nMobile Drop?');
  });

  it('compares lan folders ignoring trailing slashes', () => {
    expect(sameFolder('lan://mobile', 'lan://mobile/')).toBe(true);
    expect(sameFolder('lan://mobile/incoming', 'lan://mobile/outgoing')).toBe(false);
  });

  it('resolves incoming destination for dual-pane and single-pane modes', () => {
    // Single pane: always null (defaults to Downloads folder)
    expect(resolveLanIncomingDestination(false, 'lan://mobile', 'C:\\Work')).toBeNull();
    expect(resolveLanIncomingDestination(false, 'C:\\Work', null)).toBeNull();

    // Dual pane: Mobile Drop in active pane, other pane is destination
    expect(resolveLanIncomingDestination(true, 'lan://mobile', 'D:\\Projects')).toBe('D:\\Projects');

    // Dual pane: Mobile Drop in second pane, active pane is destination
    expect(resolveLanIncomingDestination(true, 'C:\\Users\\Surface\\Docs', 'lan://mobile')).toBe('C:\\Users\\Surface\\Docs');

    // Dual pane: both are regular local folders -> second pane is destination
    expect(resolveLanIncomingDestination(true, 'C:\\PaneA', 'D:\\PaneB')).toBe('D:\\PaneB');

    // Dual pane: other pane is GDrive or invalid -> returns null (defaults to Downloads)
    expect(resolveLanIncomingDestination(true, 'lan://mobile', 'gdrive://root')).toBeNull();
    expect(resolveLanIncomingDestination(true, 'lan://mobile', null)).toBeNull();
  });

  it('resolves a Google Drive upload destination only when paired with Mobile Drop in dual-pane', () => {
    // Single pane: never a Drive destination
    expect(resolveLanGDriveDestination(false, 'lan://mobile', 'gdrive://root')).toBeNull();

    // Dual pane: Mobile Drop in active pane, other pane is a Drive folder
    expect(resolveLanGDriveDestination(true, 'lan://mobile', 'gdrive://folderABC')).toBe('gdrive://folderABC');

    // Dual pane: Mobile Drop in second pane, active pane is a Drive folder
    expect(resolveLanGDriveDestination(true, 'gdrive://folderABC', 'lan://mobile')).toBe('gdrive://folderABC');

    // Dual pane: other pane is a plain local folder, not Drive -> null (falls back to resolveLanIncomingDestination)
    expect(resolveLanGDriveDestination(true, 'lan://mobile', 'D:\\Projects')).toBeNull();

    // Dual pane: neither side is Mobile Drop -> null
    expect(resolveLanGDriveDestination(true, 'C:\\PaneA', 'gdrive://folderABC')).toBeNull();
  });
});
