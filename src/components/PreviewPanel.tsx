import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Expand,
  Lock,
  Unlock,
  Hash,
  X,
} from 'lucide-react';
import { FileItem } from '../types';
import { VideoPlayer } from './VideoPlayer';
import { isVideoExt } from '../video';

interface PreviewPanelProps {
  selectedItem: FileItem | null;
  allItems: FileItem[];
  onClose: () => void;
  onSelectFile: (file: FileItem) => void;
}

export const PreviewPanel: React.FC<PreviewPanelProps> = ({
  selectedItem,
  allItems,
  onClose,
  onSelectFile,
}) => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);

  // Image viewer state
  const [zoom, setZoom] = useState<number>(1);
  const [is1To1, setIs1To1] = useState<boolean>(false);
  const [isLockZoom, setIsLockZoom] = useState<boolean>(false);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [showGotoModal, setShowGotoModal] = useState<boolean>(false);
  const [gotoIndexInput, setGotoIndexInput] = useState<string>('');

  const imageContainerRef = useRef<HTMLDivElement>(null);

  // Filter image items in directory for folder image navigation
  const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];
  const folderImages = allItems.filter(
    (item) => !item.is_dir && imageExtensions.includes(item.ext.toLowerCase())
  );

  const currentImageIndex = selectedItem
    ? folderImages.findIndex((img) => img.path === selectedItem.path)
    : -1;

  const isImage =
    selectedItem &&
    !selectedItem.is_dir &&
    imageExtensions.includes(selectedItem.ext.toLowerCase());

  const isVideo = !!selectedItem && !selectedItem.is_dir && isVideoExt(selectedItem.ext);

  // Load preview data whenever selected item changes
  useEffect(() => {
    if (!selectedItem || selectedItem.is_dir || isVideo) {
      setImageSrc(null);
      setTextContent(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    if (isImage) {
      setTextContent(null);
      // Reset zoom & pan if Lock Zoom is disabled
      if (!isLockZoom) {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setIs1To1(false);
      }

      invoke<string>('read_image_base64', { path: selectedItem.path })
        .then((b64) => setImageSrc(b64))
        .catch((err) => console.error('Image load error:', err))
        .finally(() => setLoading(false));
    } else {
      setImageSrc(null);
      invoke<string>('read_text_file', { path: selectedItem.path })
        .then((text) => setTextContent(text))
        .catch(() => setTextContent('Binary or unreadable file content.'))
        .finally(() => setLoading(false));
    }
  }, [selectedItem?.path]);

  // Folder Image Navigation Handlers
  const handleNavFirst = () => {
    if (folderImages.length > 0) onSelectFile(folderImages[0]);
  };

  const handleNavPrev = () => {
    if (currentImageIndex > 0) {
      onSelectFile(folderImages[currentImageIndex - 1]);
    }
  };

  const handleNavNext = () => {
    if (currentImageIndex >= 0 && currentImageIndex < folderImages.length - 1) {
      onSelectFile(folderImages[currentImageIndex + 1]);
    }
  };

  const handleNavLast = () => {
    if (folderImages.length > 0) {
      onSelectFile(folderImages[folderImages.length - 1]);
    }
  };

  const handleGotoSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const idx = parseInt(gotoIndexInput, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < folderImages.length) {
      onSelectFile(folderImages[idx]);
      setShowGotoModal(false);
    }
  };

  // Zoom controls
  const handleZoomIn = () => {
    setZoom((z) => Math.min(z * 1.25, 8));
    setIs1To1(false);
  };

  const handleZoomOut = () => {
    setZoom((z) => Math.max(z / 1.25, 0.2));
    setIs1To1(false);
  };

  const handleToggle1To1 = () => {
    if (is1To1) {
      setZoom(1);
      setIs1To1(false);
    } else {
      setZoom(2.0); // 100% native actual size representation
      setIs1To1(true);
    }
    setPan({ x: 0, y: 0 });
  };

  const handleFitToWindow = () => {
    setZoom(1);
    setIs1To1(false);
    setPan({ x: 0, y: 0 });
  };

  // Mouse Drag / Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isImage) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Global Keyboard Navigation for Image Viewer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Image keys must not fire while typing in a text field (search box, path bar, dialogs, Go-to input)
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inTextField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        setIsFullScreen(false);
      } else if (inTextField) {
        return;
      } else if (isImage) {
        if (e.key === 'Home') handleNavFirst();
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') handleNavPrev();
        else if (e.key === 'ArrowRight' || e.key === 'PageDown') handleNavNext();
        else if (e.key === 'End') handleNavLast();
        else if (e.key === '+' || e.key === '=') handleZoomIn();
        else if (e.key === '-') handleZoomOut();
        else if (e.key === '1') handleToggle1To1();
        else if (e.key === '0' || e.key.toLowerCase() === 'f') handleFitToWindow();
        else if (e.key.toLowerCase() === 'l') setIsLockZoom((v) => !v);
        else if (e.ctrlKey && e.key.toLowerCase() === 'g') {
          e.preventDefault();
          setShowGotoModal(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isImage, currentImageIndex, folderImages]);

  if (!selectedItem) {
    return (
      <div className="preview-panel" style={{ height: '100%', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center' }}>
          Select a file to inspect preview
        </div>
      </div>
    );
  }

  return (
    <div className={`preview-panel ${isFullScreen ? 'fullscreen-preview' : ''}`} style={{ height: '100%' }}>
      {/* Preview Header */}
      <div className="preview-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          <span style={{ fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedItem.name}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            ({selectedItem.size_formatted})
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {isImage && (
            <>
              {/* Image Navigation Buttons */}
              <button onClick={handleNavFirst} disabled={currentImageIndex <= 0} title="First Image (Home)">
                <ChevronsLeft size={13} />
              </button>
              <button onClick={handleNavPrev} disabled={currentImageIndex <= 0} title="Previous Image (Left Arrow)">
                <ChevronLeft size={13} />
              </button>

              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '0 4px' }}>
                {currentImageIndex >= 0 ? `${currentImageIndex + 1}/${folderImages.length}` : ''}
              </span>

              <button
                onClick={handleNavNext}
                disabled={currentImageIndex >= folderImages.length - 1}
                title="Next Image (Right Arrow)"
              >
                <ChevronRight size={13} />
              </button>
              <button
                onClick={handleNavLast}
                disabled={currentImageIndex >= folderImages.length - 1}
                title="Last Image (End)"
              >
                <ChevronsRight size={13} />
              </button>

              <button onClick={() => setShowGotoModal(true)} title="Go To Image (Ctrl+G)">
                <Hash size={13} />
              </button>

              <div style={{ width: 1, height: 14, background: 'var(--border-color)', margin: '0 2px' }} />

              {/* Zoom & View Controls */}
              <button onClick={handleZoomIn} title="Zoom In (+)">
                <ZoomIn size={13} />
              </button>
              <button onClick={handleZoomOut} title="Zoom Out (-)">
                <ZoomOut size={13} />
              </button>
              <button
                className={is1To1 ? 'active' : ''}
                onClick={handleToggle1To1}
                title="1:1 Native Resolution (1)"
              >
                1:1
              </button>
              <button onClick={handleFitToWindow} title="Fit to Window (0)">
                <Expand size={13} />
              </button>
              <button
                className={isLockZoom ? 'active' : ''}
                onClick={() => setIsLockZoom(!isLockZoom)}
                title="Lock Zoom Mode (L)"
              >
                {isLockZoom ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </>
          )}

          {/* Full Screen / Panel Mode Toggle Button */}
          <button
            className={isFullScreen ? 'active' : ''}
            onClick={() => setIsFullScreen(!isFullScreen)}
            title={isFullScreen ? 'Exit Full Screen Preview (Esc)' : 'Maximize Preview to Full Screen'}
          >
            {isFullScreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>

          <button onClick={onClose} title="Close Preview Drawer (Ctrl+P)">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Preview Content Body */}
      <div className="preview-body">
        {isVideo ? (
          <VideoPlayer
            key={selectedItem.path}
            item={selectedItem}
            siblings={allItems}
            onToggleFullScreen={() => setIsFullScreen((v) => !v)}
          />
        ) : loading ? (
          <div style={{ color: 'var(--text-muted)' }}>Loading preview...</div>
        ) : isImage && imageSrc ? (
          <div
            className="image-canvas-container"
            ref={imageContainerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <img
              src={imageSrc}
              alt={selectedItem.name}
              className="image-preview-element"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
              draggable={false}
            />
          </div>
        ) : textContent !== null ? (
          <div
            style={{
              width: '100%',
              height: '100%',
              overflow: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              color: 'var(--text-main)',
              padding: 8,
              userSelect: 'text',
            }}
          >
            {textContent}
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)' }}>No preview available for this file.</div>
        )}
      </div>

      {/* Goto Image Index Modal */}
      {showGotoModal && (
        <div
          style={{
            position: 'absolute',
            top: 40,
            right: 40,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-light)',
            padding: 12,
            borderRadius: 6,
            zIndex: 100,
            boxShadow: '0 4px 12px rgba(0,0,0,0.8)',
          }}
        >
          <form onSubmit={handleGotoSubmit} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11 }}>Go to image (1-{folderImages.length}):</span>
            <input
              type="number"
              min={1}
              max={folderImages.length}
              value={gotoIndexInput}
              onChange={(e) => setGotoIndexInput(e.target.value)}
              style={{ width: 60 }}
              autoFocus
            />
            <button type="submit">Jump</button>
            <button type="button" onClick={() => setShowGotoModal(false)}>
              Cancel
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
