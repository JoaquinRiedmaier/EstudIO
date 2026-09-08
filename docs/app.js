/**
 * EstudIO Web Landing & Release Download Helper
 * Repo: JoaquinRiedmaier/EstudIO
 */

const REPO_OWNER = 'JoaquinRiedmaier';
const REPO_NAME = 'EstudIO';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const FALLBACK_RELEASE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

// Helper: Format bytes to MB/KB
function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1048576) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  return (bytes / 1024).toFixed(0) + ' KB';
}

// Detect OS and Architecture
async function detectSystem() {
  let os = 'windows';
  let arch = 'x64';
  let osLabel = 'Windows';
  let archLabel = '64-bit';
  let iconClass = '💻';

  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();

  // OS Detection
  if (ua.includes('win') || platform.includes('win')) {
    os = 'windows';
    osLabel = 'Windows';
    iconClass = '🪟';
  } else if (ua.includes('mac') || platform.includes('mac')) {
    os = 'macos';
    osLabel = 'macOS';
    iconClass = '🍎';
  } else if (ua.includes('linux') || platform.includes('linux')) {
    os = 'linux';
    osLabel = 'Linux';
    iconClass = '🐧';
  }

  // Architecture Detection
  if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
    try {
      const hints = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
      if (hints.architecture === 'arm' || hints.architecture === 'arm64' || ua.includes('arm64') || ua.includes('aarch64')) {
        arch = 'arm64';
      }
    } catch (e) {}
  }

  if (os === 'macos') {
    if (ua.includes('arm64') || ua.includes('aarch64') || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2)) {
      arch = 'arm64';
      archLabel = 'Apple Silicon (M1/M2/M3/M4)';
    } else {
      arch = 'x64';
      archLabel = 'Intel Mac';
    }
  } else {
    archLabel = arch === 'arm64' ? 'ARM64' : 'x64';
  }

  return { os, arch, osLabel, archLabel, iconClass };
}

// Map assets from GitHub release
function mapAssets(assets) {
  const mapped = {
    win_x64: null,
    mac_arm64: null,
    mac_x64: null,
    linux_appimage: null,
    linux_deb: null,
    all: assets || []
  };

  if (!assets || !Array.isArray(assets)) return mapped;

  assets.forEach(asset => {
    const name = asset.name.toLowerCase();
    const url = asset.browser_download_url;
    const size = formatFileSize(asset.size);
    const item = { name: asset.name, url, size };

    if (name.endsWith('.msi') || name.endsWith('.exe') || name.includes('x64-setup') || name.endsWith('.nsis.zip')) {
      if (!mapped.win_x64 || name.endsWith('.exe') || name.endsWith('.msi')) {
        mapped.win_x64 = item;
      }
    } else if (name.includes('aarch64') && (name.endsWith('.dmg') || name.endsWith('.tar.gz'))) {
      if (!mapped.mac_arm64 || name.endsWith('.dmg')) {
        mapped.mac_arm64 = item;
      }
    } else if ((name.includes('x64') || name.includes('x86_64')) && (name.endsWith('.dmg') || name.endsWith('.tar.gz'))) {
      if (!mapped.mac_x64 || name.endsWith('.dmg')) {
        mapped.mac_x64 = item;
      }
    } else if (name.endsWith('.appimage')) {
      mapped.linux_appimage = item;
    } else if (name.endsWith('.deb')) {
      mapped.linux_deb = item;
    }
  });

  return mapped;
}

// Fetch Latest Release & Setup Download UI
async function setupDownloadSection() {
  const sys = await detectSystem();
  
  const osIconEl = document.getElementById('os-icon');
  const osNameEl = document.getElementById('os-name');
  const osArchEl = document.getElementById('os-arch');
  const btnDownload = document.getElementById('btn-primary-download');
  const btnDownloadText = document.getElementById('btn-download-text');
  const releaseTagEl = document.getElementById('release-tag');
  const downloadSizeEl = document.getElementById('download-size');
  const altListEl = document.getElementById('alt-downloads-list');

  if (osIconEl) osIconEl.textContent = sys.iconClass;
  if (osNameEl) osNameEl.textContent = `Recomendado para ${sys.osLabel}`;
  if (osArchEl) osArchEl.textContent = `Arquitectura: ${sys.archLabel}`;

  try {
    const res = await fetch(LATEST_RELEASE_API);
    if (!res.ok) throw new Error('GitHub API Error');
    const releaseData = await res.json();
    const versionTag = releaseData.tag_name || releaseData.name || 'v1.2.3';
    
    if (releaseTagEl) releaseTagEl.textContent = versionTag;

    const mapped = mapAssets(releaseData.assets);

    let recommended = null;
    if (sys.os === 'windows') {
      recommended = mapped.win_x64;
    } else if (sys.os === 'macos') {
      recommended = sys.arch === 'arm64' ? (mapped.mac_arm64 || mapped.mac_x64) : (mapped.mac_x64 || mapped.mac_arm64);
    } else if (sys.os === 'linux') {
      recommended = mapped.linux_appimage || mapped.linux_deb;
    }

    if (recommended && recommended.url) {
      if (btnDownload) {
        btnDownload.href = recommended.url;
        btnDownload.setAttribute('download', '');
      }
      if (btnDownloadText) {
        btnDownloadText.textContent = `Descargar EstudIO para ${sys.osLabel} (${sys.archLabel})`;
      }
      if (downloadSizeEl) {
        downloadSizeEl.textContent = `Tamaño: ~${recommended.size}`;
      }
    } else {
      if (btnDownload) btnDownload.href = releaseData.html_url || FALLBACK_RELEASE_URL;
      if (btnDownloadText) btnDownloadText.textContent = `Descargar EstudIO ${versionTag} desde GitHub`;
      if (downloadSizeEl) downloadSizeEl.textContent = 'Instalador nativo multiplataforma';
    }

    if (altListEl) {
      altListEl.innerHTML = `
        <div class="platform-group">
          <div class="platform-group-title">🪟 Windows</div>
          <div class="platform-download-list">
            ${mapped.win_x64 ? `
              <a href="${mapped.win_x64.url}" class="platform-download-item">
                <span class="file-name">Instalador Windows (x64) - ${mapped.win_x64.name}</span>
                <span class="file-badge">${mapped.win_x64.size}</span>
              </a>
            ` : '<div class="platform-download-item"><span class="file-name">Instalador de Windows disponible en Releases</span></div>'}
          </div>
        </div>

        <div class="platform-group">
          <div class="platform-group-title">🍎 macOS</div>
          <div class="platform-download-list">
            ${mapped.mac_arm64 ? `
              <a href="${mapped.mac_arm64.url}" class="platform-download-item">
                <span class="file-name">Apple Silicon (M1/M2/M3/M4) - ${mapped.mac_arm64.name}</span>
                <span class="file-badge">${mapped.mac_arm64.size}</span>
              </a>
            ` : ''}
            ${mapped.mac_x64 ? `
              <a href="${mapped.mac_x64.url}" class="platform-download-item">
                <span class="file-name">Intel Mac (x64) - ${mapped.mac_x64.name}</span>
                <span class="file-badge">${mapped.mac_x64.size}</span>
              </a>
            ` : ''}
            ${!mapped.mac_arm64 && !mapped.mac_x64 ? '<div class="platform-download-item"><span class="file-name">Paquetes para macOS disponibles en Releases</span></div>' : ''}
          </div>
        </div>

        <div class="platform-group">
          <div class="platform-group-title">🐧 Linux</div>
          <div class="platform-download-list">
            ${mapped.linux_appimage ? `
              <a href="${mapped.linux_appimage.url}" class="platform-download-item">
                <span class="file-name">Linux AppImage - ${mapped.linux_appimage.name}</span>
                <span class="file-badge">${mapped.linux_appimage.size}</span>
              </a>
            ` : ''}
            ${mapped.linux_deb ? `
              <a href="${mapped.linux_deb.url}" class="platform-download-item">
                <span class="file-name">Linux Debian/Ubuntu (.deb) - ${mapped.linux_deb.name}</span>
                <span class="file-badge">${mapped.linux_deb.size}</span>
              </a>
            ` : ''}
            ${!mapped.linux_appimage && !mapped.linux_deb ? '<div class="platform-download-item"><span class="file-name">Paquetes de Linux disponibles en Releases</span></div>' : ''}
          </div>
        </div>
      `;
    }

  } catch (err) {
    console.warn('Fallback to default release URL:', err);
    if (btnDownload) btnDownload.href = FALLBACK_RELEASE_URL;
    if (btnDownloadText) btnDownloadText.textContent = `Descargar EstudIO para ${sys.osLabel}`;
    if (releaseTagEl) releaseTagEl.textContent = 'v1.2.3';
  }
}

// Dynamic README.md Loader & Parser
async function loadReadmeFromMarkdown() {
  try {
    const res = await fetch('README.md');
    if (!res.ok) return;
    const text = await res.text();
    if (!text.trim()) return;

    const shortcutMatch = text.match(/#\s*¿Querés tomar apuntes más rápido[\s\S]*?(?=---|\n##|$)/i);
    if (shortcutMatch) {
      const shortcutBlock = shortcutMatch[0];
      const lines = shortcutBlock.split('\n');
      const tableBody = document.querySelector('.shortcuts-table tbody');

      if (tableBody) {
        let rowsHtml = '';
        lines.forEach(line => {
          const match = line.match(/^(\d+)\.\s*['"]?(.+?)['"]?\s*:\s*(.+)$/i) || line.match(/^(\d+)\.\s*(.+)$/);
          if (match) {
            const rawKey = match[2] || match[1];
            const rawDesc = match[3] || match[2];
            const cleanKey = rawKey.replace(/^['"]|['"]$/g, '');

            rowsHtml += `
              <tr>
                <td>${rawDesc}</td>
                <td><kbd>${cleanKey}</kbd></td>
                <td><button class="btn-copy-shortcut" data-shortcut="${cleanKey}">Copiar ${cleanKey}</button></td>
              </tr>
            `;
          }
        });

        if (rowsHtml) {
          tableBody.innerHTML = rowsHtml;
          setupCopyShortcuts();
        }
      }
    }
  } catch (e) {
    console.log('Using static HTML README fallback', e);
  }
}

// Dynamic CHANGELOG.md Loader & Parser
async function loadChangelogFromMarkdown() {
  const container = document.getElementById('changelog-timeline-container');
  if (!container) return;

  try {
    const res = await fetch('CHANGELOG.md');
    if (!res.ok) return;
    const text = await res.text();
    if (!text.trim()) return;

    const rawSections = text.split(/(?=\n# Version|\n# FIX|\n# [Vv]ersión)/g);
    let htmlContent = '';

    rawSections.forEach(sec => {
      const trimmed = sec.trim();
      if (!trimmed) return;

      const lines = trimmed.split('\n');
      const headerLine = lines[0] || '';
      
      let versionTitle = headerLine.replace(/^#\s*/, '').trim();
      if (!versionTitle) return;

      const items = [];
      let currentItemText = '';

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('- ')) {
          if (currentItemText) items.push(currentItemText);
          currentItemText = line.substring(2);
        } else {
          if (currentItemText) {
            currentItemText += ' ' + line;
          } else {
            items.push(line);
          }
        }
      }
      if (currentItemText) items.push(currentItemText);

      let itemsHtml = '';
      items.forEach(item => {
        let badgeClass = 'improvement';
        let badgeLabel = 'Mejora';
        let cleanBody = item;

        // Check if item starts with **Prefix:** or **Prefix**
        const prefixMatch = item.match(/^\*\*(.*?)\*\*:?\s*(.*)$/);
        if (prefixMatch) {
          const prefixText = prefixMatch[1].toLowerCase();
          cleanBody = prefixMatch[2] || prefixMatch[1]; // Extract text after prefix to avoid duplication

          if (prefixText.includes('nueva') || prefixText.includes('funcionalidad') || prefixText.includes('feature')) {
            badgeClass = 'feature';
            badgeLabel = 'Nueva Funcionalidad';
          } else if (prefixText.includes('fix') || prefixText.includes('error') || prefixText.includes('corrección') || prefixText.includes('corregid')) {
            badgeClass = 'fix';
            badgeLabel = 'Fix';
          } else {
            badgeClass = 'improvement';
            badgeLabel = 'Mejora';
          }
        } else {
          const lower = item.toLowerCase();
          if (lower.includes('nueva funcionalidad') || lower.includes('funcionalidad')) {
            badgeClass = 'feature';
            badgeLabel = 'Nueva Funcionalidad';
          } else if (lower.includes('fix') || lower.includes('error') || lower.includes('correg')) {
            badgeClass = 'fix';
            badgeLabel = 'Fix';
          }
        }

        // Format inner bold text **text** to <strong> and `code` to <code>
        let formattedText = cleanBody
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');

        itemsHtml += `
          <li class="changelog-item">
            <span class="badge ${badgeClass}">${badgeLabel}</span>
            <span>${formattedText}</span>
          </li>
        `;
      });

      htmlContent += `
        <div class="changelog-card">
          <div class="changelog-header">
            <span class="changelog-version">${versionTitle}</span>
          </div>
          <ul class="changelog-list">
            ${itemsHtml}
          </ul>
        </div>
      `;
    });

    if (htmlContent) {
      container.innerHTML = htmlContent;
    }
  } catch (e) {
    console.log('Using static HTML changelog fallback', e);
  }
}

// Tab Switcher Handler
function setupTabs() {
  const buttons = document.querySelectorAll('.tab-button');
  const contents = document.querySelectorAll('.tab-content');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');

      buttons.forEach(b => b.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetContent = document.getElementById(targetId);
      if (targetContent) {
        targetContent.classList.add('active');
      }
    });
  });
}

// Toggle Alternative Downloads List
function setupAltToggle() {
  const toggleBtn = document.getElementById('btn-toggle-alt');
  const box = document.getElementById('all-platforms-box');

  if (toggleBtn && box) {
    toggleBtn.addEventListener('click', () => {
      box.classList.toggle('active');
      const isActive = box.classList.contains('active');
      toggleBtn.innerHTML = isActive
        ? '▲ Ocultar opciones alternativas'
        : '▼ Ver todas las plataformas y versiones';
    });
  }
}

// Copy Shortcut to Clipboard Toast
function showToast(message) {
  const existing = document.querySelector('.toast-notice');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-notice';
  toast.innerHTML = `<span>📋</span> <span>${message}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function setupCopyShortcuts() {
  document.querySelectorAll('.btn-copy-shortcut').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.getAttribute('data-shortcut');
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          showToast(`Atajo "${text}" copiado al portapapeles`);
        }).catch(() => {
          showToast(`Copiado: ${text}`);
        });
      }
    });
  });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  setupDownloadSection();
  loadReadmeFromMarkdown();
  loadChangelogFromMarkdown();
  setupTabs();
  setupAltToggle();
  setupCopyShortcuts();
});
