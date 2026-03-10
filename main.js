let map = null;
let markers = [];
let lines = [];
let currentEventSource = null;
let allCategories = [];
let baseLayerLight = null;
let activeBaseLayer = null;

let previewMarker = null;
let previewCircle = null;
let previewCenter = null; // {lat, lon, bbox?, name?}
let previewDebounceTimer = null;
let lastPreviewQuery = '';

let lastSearchResult = null;
let lastSearchConfig = null;

// Navigazione risultati (catene) sulla mappa
let resultNavigator = {
    chains: [],
    index: 0,
    intervalMs: 3000,
    timer: null,
    control: null,
    tooltipTimer: null
};

// Colori per le categorie
const categoryColors = [
    '#dc3545', '#198754', '#0d6efd', '#fd7e14', '#6f42c1',
    '#20c997', '#e83e8c', '#ffc107', '#17a2b8', '#6c757d'
];

// Costanti di default
const DEFAULT_MIN_DIST = 50;
const DEFAULT_MAX_DIST = 500;

function getCategoryColor(index) {
    return categoryColors[index % categoryColors.length];
}

// Stato globale della catena di categorie
let categoryChain = [];
let chainCount = 0;
let links = {};  // links[`${from}-${to}`] = { minDist, maxDist }

function setFiltersEnabled(enabled) {
    const formCard = document.getElementById('formCard');
    if (!formCard) return;
    formCard.classList.toggle('is-busy', !enabled);

    // Disabilita solo i controlli dentro la card filtri
    try {
        formCard.querySelectorAll('input, button, select, textarea').forEach(el => {
            // Non disabilitare il toggle manuale dei singoli box? durante loading va bene bloccare tutto.
            el.disabled = !enabled;
        });
    } catch (e) {}

    // Mantieni attivo il toggle della sidebar
    const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
    if (sidebarToggleBtn) sidebarToggleBtn.disabled = false;
}

// Inizializza le categorie iniziali
document.addEventListener('DOMContentLoaded', async function() {
    initShellControls();
    applySavedTheme();
    ensureMap();
    setupPreviewHandlers();
    initSidebarModeControls();
    initPdfExport();
    await loadCategories();
    initializeChain();
    renderHistoryList();

    const y = document.getElementById('footerYear');
    if (y) y.textContent = String(new Date().getFullYear());
});

function renderResultsList(result) {
    const container = document.getElementById('resultsList');
    if (!container) return;
    container.innerHTML = '';

    const chains = Array.isArray(result?.chains) ? result.chains : [];
    const edges = Array.isArray(result?.pairs) ? result.pairs : [];

    if (chains.length === 0) {
        container.innerHTML = '';
        return;
    }

    const edgesByChain = new Map();
    edges.forEach(e => {
        const id = (e.chain_id !== undefined && e.chain_id !== null) ? e.chain_id : null;
        if (id === null) return;
        const arr = edgesByChain.get(id) || [];
        arr.push(e);
        edgesByChain.set(id, arr);
    });

    const truncate = (s, n) => (s && s.length > n ? (s.slice(0, n - 1) + '…') : s);

    chains.forEach((ch, idx) => {
        const chainId = (ch && ch.id !== undefined && ch.id !== null) ? ch.id : idx;
        const pts = Array.isArray(ch.points) ? ch.points : [];

        const titleParts = pts.map(p => {
            const name = (p && p.name && p.name !== 'Senza nome') ? p.name : '';
            return truncate(name || p.category || 'Luogo', 34);
        });
        const title = truncate(titleParts.join(' → '), 88);

        const eds = edgesByChain.get(chainId) || [];
        const metaParts = eds
            .slice()
            .sort((a, b) => (a.dist_m || 0) - (b.dist_m || 0))
            .slice(0, 4)
            .map(e => `${e.cat1}→${e.cat2} ${e.dist_m}m`);
        const meta = metaParts.join(' • ') + (eds.length > 4 ? ' …' : '');

        const item = document.createElement('div');
        item.className = 'result-item';
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.dataset.chainId = String(chainId);
        item.innerHTML = `
            <div class="ri-title">${title || `Risultato ${idx + 1}`}</div>
            <div class="ri-meta">${meta || `${pts.length} punti`}</div>
        `;

        const go = () => {
            try {
                focusChain(chainId);
            } catch (e) {}
        };
        item.addEventListener('click', go);
        item.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                go();
            }
        });

        container.appendChild(item);
    });
}

function initShellControls() {
    const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
    if (sidebarToggleBtn) {
        // Sync iniziale (nel caso in cui classi/stato vengano ripristinati dal browser)
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        sidebarToggleBtn.classList.toggle('is-collapsed', collapsed);
        sidebarToggleBtn.title = collapsed ? 'Mostra pannello' : 'Nascondi pannello';
        sidebarToggleBtn.setAttribute('aria-label', collapsed ? 'Mostra pannello' : 'Nascondi pannello');

        sidebarToggleBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const isCollapsed = document.body.classList.contains('sidebar-collapsed');
            setSidebarCollapsed(!isCollapsed);
        });
        sidebarToggleBtn.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                const isCollapsed = document.body.classList.contains('sidebar-collapsed');
                setSidebarCollapsed(!isCollapsed);
            }
        });
    }

    const themeToggleBtn = document.getElementById('themeToggleBtn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const isDark = document.body.getAttribute('data-bs-theme') === 'dark';
            setTheme(isDark ? 'light' : 'dark');
        });
        themeToggleBtn.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                themeToggleBtn.click();
            }
        });
    }

    initSidebarResizer();
}

function initSidebarModeControls() {
    const btnFilters = document.getElementById('sidebarModeFilters');
    const btnHistory = document.getElementById('sidebarModeHistory');
    if (btnFilters) btnFilters.addEventListener('click', () => setSidebarMode('filters'));
    if (btnHistory) btnHistory.addEventListener('click', () => setSidebarMode('history'));

    const clearBtn = document.getElementById('clearHistoryBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            try { localStorage.removeItem('geoFilterHistory'); } catch (e) {}
            renderHistoryList();
        });
    }

    setSidebarMode('filters');
}

function setSidebarMode(mode) {
    const filtersPane = document.getElementById('filtersPane');
    const historyPane = document.getElementById('historyPane');
    const btnFilters = document.getElementById('sidebarModeFilters');
    const btnHistory = document.getElementById('sidebarModeHistory');

    if (mode === 'history') {
        filtersPane?.classList.add('d-none');
        historyPane?.classList.remove('d-none');
        btnFilters?.classList.remove('active');
        btnHistory?.classList.add('active');
        renderHistoryList();
    } else {
        historyPane?.classList.add('d-none');
        filtersPane?.classList.remove('d-none');
        btnHistory?.classList.remove('active');
        btnFilters?.classList.add('active');
    }
}

function setSidebarCollapsed(collapsed) {
    if (collapsed) document.body.classList.add('sidebar-collapsed');
    else document.body.classList.remove('sidebar-collapsed');
    const btn = document.getElementById('sidebarToggleBtn');
    if (btn) {
        btn.classList.toggle('is-collapsed', collapsed);
        btn.title = collapsed ? 'Mostra pannello' : 'Nascondi pannello';
        btn.setAttribute('aria-label', collapsed ? 'Mostra pannello' : 'Nascondi pannello');
    }
    setTimeout(() => {
        try { map?.invalidateSize(); } catch (e) {}
    }, 260);
}

function initSidebarResizer() {
    const handle = document.getElementById('sidebarHandle');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;

    // Restore saved width
    try {
        const saved = parseInt(localStorage.getItem('geoFilterSidebarWidth') || '', 10);
        if (Number.isFinite(saved) && saved >= 320 && saved <= 720) {
            sidebar.style.width = saved + 'px';
        }
    } catch (e) {}

    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (ev) => {
        if (!isDragging) return;
        const x = ev.clientX ?? (ev.touches && ev.touches[0]?.clientX);
        if (!Number.isFinite(x)) return;
        const dx = x - startX;
        const newW = Math.max(320, Math.min(720, startWidth + dx));
        sidebar.style.width = newW + 'px';
        try { map?.invalidateSize(); } catch (e) {}
    };

    const onUp = () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.classList.remove('sidebar-resizing');
        document.body.style.userSelect = '';
        try {
            const w = parseInt(getComputedStyle(sidebar).width, 10);
            if (Number.isFinite(w)) localStorage.setItem('geoFilterSidebarWidth', String(w));
        } catch (e) {}
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointerdown', (ev) => {
        // Su mobile evitare resize (UX scarsa)
        if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return;

        // Se clicchi il bottone toggle, non iniziare il resize
        if (ev.target && ev.target.closest && ev.target.closest('#sidebarToggleBtn')) return;

        // Se sidebar chiusa, niente resize (apri prima)
        if (document.body.classList.contains('sidebar-collapsed')) return;

        isDragging = true;
        document.body.classList.add('sidebar-resizing');
        startX = ev.clientX;
        startWidth = parseInt(getComputedStyle(sidebar).width, 10) || sidebar.offsetWidth || 420;
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });
}

function initPdfExport() {
    const btn = document.getElementById('exportPdfBtn');
    if (!btn) return;
    btn.addEventListener('click', () => exportPdf());
}

function exportPdf() {
    if (!lastSearchResult || !lastSearchConfig) {
        alert("Nessun risultato da esportare.");
        return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("Libreria PDF non disponibile.");
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    const now = new Date();
    const city = lastSearchConfig.city || '';
    const radius = lastSearchConfig.searchRadius || lastSearchConfig.radius || '';
    const chains = Array.isArray(lastSearchResult.chains) ? lastSearchResult.chains : [];
    const edges = Array.isArray(lastSearchResult.pairs) ? lastSearchResult.pairs : [];

    let y = 14;
    const pageW = doc.internal.pageSize.getWidth();
    const marginX = 14;
    const maxW = pageW - marginX * 2;

    const line = (txt, inc = 5, fontSize = null, isBold = false) => {
        if (fontSize) doc.setFontSize(fontSize);
        try { doc.setFont('helvetica', isBold ? 'bold' : 'normal'); } catch (e) {}
        const parts = doc.splitTextToSize(String(txt), maxW);
        parts.forEach((p) => {
            doc.text(p, marginX, y);
            y += inc;
            if (y > 282) {
                doc.addPage();
                y = 14;
            }
        });
    };

    line("Geo Filter OSM", 7, 14, true);
    line(`Data: ${now.toLocaleString()}`, 5, 10, false);
    line(`Città: ${city}`, 5, 10, false);
    line(`Raggio: ${radius} m`, 5, 10, false);
    line(`Risultati: ${chains.length}`, 6, 10, false);
    y += 2;

    // Mappa edges per chain
    const edgesByChain = new Map();
    edges.forEach(e => {
        const id = (e.chain_id !== undefined && e.chain_id !== null) ? e.chain_id : null;
        if (id === null) return;
        const arr = edgesByChain.get(id) || [];
        arr.push(e);
        edgesByChain.set(id, arr);
    });

    chains.slice(0, 60).forEach((ch, idx) => {
        const chainId = (ch && ch.id !== undefined && ch.id !== null) ? ch.id : idx;
        const pts = Array.isArray(ch.points) ? ch.points : [];
        const title = pts.map(p => (p.name && p.name !== 'Senza nome') ? p.name : (p.category || 'Luogo')).join(" → ");
        line(`${idx + 1}. ${title || 'Risultato'}`, 5, 11, true);
        doc.setFontSize(9);
        pts.forEach(p => {
            const nm = (p.name && p.name !== 'Senza nome') ? p.name : '';
            const lat = Number(p.lat);
            const lon = Number(p.lon);
            const mapsUrl = `https://www.google.com/maps/?q=${lat},${lon}`;
            line(`  • ${p.category}: ${nm} (${lat.toFixed(5)}, ${lon.toFixed(5)})`, 4.6, 9, false);
            // Link Google Maps (cliccabile se supportato)
            try {
                if (typeof doc.textWithLink === 'function') {
                    doc.setFontSize(8);
                    doc.textWithLink(`    Maps: ${mapsUrl}`, marginX, y, { url: mapsUrl });
                    y += 4.2;
                } else {
                    line(`    Maps: ${mapsUrl}`, 4.2, 8, false);
                }
            } catch (e) {
                line(`    Maps: ${mapsUrl}`, 4.2, 8, false);
            }
        });
        const eds = edgesByChain.get(chainId) || [];
        if (eds.length) {
            line(`  Distanze: ${eds.slice(0, 8).map(e => `${e.cat1}→${e.cat2} ${e.dist_m}m`).join(" • ")}${eds.length > 8 ? " …" : ""}`, 4.6, 9, false);
        }
        y += 1.5;
    });

    const safeCity = (city || "risultati").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    doc.save(`geo-filter-${safeCity || "output"}.pdf`);
}

function applySavedTheme() {
    try {
        const saved = localStorage.getItem('geoFilterTheme');
        if (saved === 'dark' || saved === 'light') {
            setTheme(saved);
        } else {
            setTheme('light');
        }
    } catch (e) {
        setTheme('light');
    }
}

function setTheme(theme) {
    document.body.setAttribute('data-bs-theme', theme);
    try { localStorage.setItem('geoFilterTheme', theme); } catch (e) {}
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
        const toTheme = theme === 'dark' ? 'light' : 'dark';
        const label = toTheme === 'dark' ? 'Passa al tema scuro' : 'Passa al tema chiaro';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }

    const iconMoon = document.getElementById('themeIconMoon');
    const iconSun = document.getElementById('themeIconSun');
    if (iconMoon && iconSun) {
        const isDark = theme === 'dark';
        iconMoon.classList.toggle('d-none', isDark);
        iconSun.classList.toggle('d-none', !isDark);
    }

    // Aggiorna layer mappa (se esiste)
    try {
        if (map) {
            setBaseLayer(theme);
        }
    } catch (e) {}
}

function ensureMap() {
    if (map) return;
    map = L.map('map', {
        zoomControl: true,
        attributionControl: true
    });

    baseLayerLight = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    });

    const theme = document.body.getAttribute('data-bs-theme') || 'light';
    setBaseLayer(theme);

    // Vista iniziale (Italia)
    map.setView([41.9028, 12.4964], 6);
    setTimeout(() => {
        try { map.invalidateSize(); } catch (e) {}
    }, 0);
}

function setBaseLayer(theme) {
    // La mappa deve rimanere "normale": usiamo sempre le tile standard OSM, anche in tema scuro.
    const desired = baseLayerLight;
    if (!desired) return;
    if (activeBaseLayer && map && map.hasLayer(activeBaseLayer)) {
        map.removeLayer(activeBaseLayer);
    }
    activeBaseLayer = desired;
    if (map && !map.hasLayer(activeBaseLayer)) {
        activeBaseLayer.addTo(map);
    }
}

function setupPreviewHandlers() {
    const cityInput = document.getElementById('city');
    const radiusInput = document.getElementById('searchRadius');
    if (!cityInput || !radiusInput) return;

    cityInput.addEventListener('input', () => schedulePreviewUpdate());
    radiusInput.addEventListener('input', () => updatePreviewRadiusOnly());

    // Se la città è già compilata (es. refresh), prova preview subito
    schedulePreviewUpdate(50);
}

function schedulePreviewUpdate(delayMs = 500) {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => updatePreviewFromInputs(), delayMs);
}

async function updatePreviewFromInputs() {
    const city = (document.getElementById('city')?.value || '').trim();
    if (!city) {
        clearPreview();
        return;
    }
    if (city === lastPreviewQuery && previewCenter) {
        updatePreviewRadiusOnly();
        return;
    }
    lastPreviewQuery = city;

    try {
        const r = await fetch('/geocode?q=' + encodeURIComponent(city));
        const data = await r.json();
        if (!data || data.status !== 'success') {
            clearPreview();
            return;
        }
        previewCenter = { lat: data.lat, lon: data.lon, name: data.name || city, bbox: data.bbox || null };
        renderPreview();
    } catch (e) {
        // Non bloccare la UI se Nominatim fallisce
        console.warn('Preview geocode fallita:', e);
    }
}

function updatePreviewRadiusOnly() {
    if (!previewCenter) return;
    renderPreview({ onlyRadius: true });
}

function clearPreview() {
    previewCenter = null;
    try { previewMarker && map?.removeLayer(previewMarker); } catch (e) {}
    try { previewCircle && map?.removeLayer(previewCircle); } catch (e) {}
    previewMarker = null;
    previewCircle = null;
}

function hidePreviewLayers() {
    try { previewMarker && map?.removeLayer(previewMarker); } catch (e) {}
    try { previewCircle && map?.removeLayer(previewCircle); } catch (e) {}
    previewMarker = null;
    previewCircle = null;
}

function renderPreview(opts = {}) {
    ensureMap();
    if (!previewCenter || !map) return;
    const radius = parseInt(document.getElementById('searchRadius')?.value, 10) || 0;
    const lat = Number(previewCenter.lat);
    const lon = Number(previewCenter.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || radius <= 0) return;

    // Il cerchio di preview deve rimanere sempre nero anche in dark mode
    const stroke = '#111827';
    const fill = '#111827';
    const fillOpacity = 0.06;

    if (!previewMarker) {
        previewMarker = L.circleMarker([lat, lon], {
            radius: 5,
            color: stroke,
            weight: 2,
            fillColor: fill,
            fillOpacity: 0.9
        }).addTo(map);
        previewMarker.bindTooltip(previewCenter.name || 'Centro', { direction: 'top', opacity: 0.9 });
    } else if (!opts.onlyRadius) {
        previewMarker.setLatLng([lat, lon]);
    }

    if (!previewCircle) {
        previewCircle = L.circle([lat, lon], {
            radius: radius,
            color: stroke,
            weight: 2,
            opacity: 0.8,
            fillColor: fill,
            fillOpacity: fillOpacity
        }).addTo(map);
    } else {
        previewCircle.setLatLng([lat, lon]);
        previewCircle.setRadius(radius);
        try { previewCircle.setStyle({ color: stroke, fillColor: fill, fillOpacity }); } catch (e) {}
    }

    // Solo se il centro è fuori vista o la query è nuova, adatta l'inquadratura.
    try {
        const centerLatLng = L.latLng(lat, lon);
        if (!map.getBounds().contains(centerLatLng)) {
            map.setView(centerLatLng, 12);
        }
        if (!opts.onlyRadius) {
            map.fitBounds(previewCircle.getBounds(), { padding: [40, 40], maxZoom: 13 });
        }
    } catch (e) {}
}

// Carica l'elenco delle categorie dal backend
async function loadCategories() {
    try {
        const response = await fetch('/get_categories');
        const data = await response.json();
        if (data.status === 'success') {
            allCategories = data.categories;
            const datalist = document.getElementById('categoriesList');
            allCategories.forEach(cat => {
                if (cat === '---') return;
                const option = document.createElement('option');
                option.value = cat;
                datalist.appendChild(option);
            });
        }
    } catch (e) {
        console.error('Errore caricamento categorie:', e);
    }
}

function initializeChain() {
    const container = document.getElementById('categoriesContainer');
    container.innerHTML = '';
    categoryChain = [];
    chainCount = 0;
    links = {};
    // Due categorie iniziali (vuote) + box link automatico tra 1→2
    addCategoryRow('');
    addCategoryRow('');
    updateRemoveCategoryButton();
}

function initializeChainWithConfig(categories, linksList) {
    const container = document.getElementById('categoriesContainer');
    if (!container) return;
    container.innerHTML = '';
    categoryChain = [];
    chainCount = 0;
    links = {};

    (categories || []).forEach(cat => {
        addCategoryRow(cat?.name || '', { mode: cat?.mode || 'list', autoLink: false });
    });
    updateRemoveCategoryButton();

    (linksList || []).forEach(lk => {
        if (lk == null) return;
        const from = Number(lk.from);
        const to = Number(lk.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;
        links[`${from}-${to}`] = {
            mode: lk.mode || 'nearest',
            minDist: (lk.minDist ?? ''),
            maxDist: (lk.maxDist ?? '')
        };
    });
    renderAllLinks();
}

function getHistory() {
    try {
        const raw = localStorage.getItem('geoFilterHistory');
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function setHistory(arr) {
    try {
        localStorage.setItem('geoFilterHistory', JSON.stringify(arr || []));
    } catch (e) {}
}

function saveHistoryEntry(config, result) {
    if (!config) return;
    const entry = {
        ts: Date.now(),
        config,
        summary: {
            city: config.city,
            radius: config.searchRadius,
            count: Array.isArray(result?.chains) ? result.chains.length : (Array.isArray(result?.pairs) ? result.pairs.length : 0)
        }
    };
    const history = getHistory();
    history.unshift(entry);
    // Dedupe soft: mantieni solo i primi 25
    const trimmed = history.slice(0, 25);
    setHistory(trimmed);
}

function renderHistoryList() {
    const container = document.getElementById('historyList');
    if (!container) return;
    const history = getHistory();
    container.innerHTML = '';

    if (history.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-muted small';
        empty.textContent = 'Nessuna ricerca salvata.';
        container.appendChild(empty);
        return;
    }

    history.forEach((h, idx) => {
        const city = h?.summary?.city || h?.config?.city || '';
        const radius = h?.summary?.radius || h?.config?.searchRadius || '';
        const count = h?.summary?.count ?? '';
        const dt = new Date(h.ts || Date.now());
        const cats = (h?.config?.categories || []).map(c => c?.name).filter(Boolean);

        const item = document.createElement('div');
        item.className = 'history-item';
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.innerHTML = `
            <div class="ri-title">${city || 'Ricerca'}</div>
            <div class="ri-meta">${dt.toLocaleString()} • Raggio ${radius}m • ${count} risultati</div>
            <div class="ri-meta">${cats.slice(0, 4).join(' → ')}${cats.length > 4 ? ' …' : ''}</div>
        `;

        const load = () => {
            const cfg = h?.config;
            if (!cfg) return;
            setSidebarMode('filters');
            document.getElementById('resultSection')?.classList.add('d-none');
            document.getElementById('errorAlert')?.classList.add('d-none');
            document.getElementById('formCard')?.classList.remove('d-none');
            setFiltersEnabled(true);

            const cityEl = document.getElementById('city');
            const radiusEl = document.getElementById('searchRadius');
            if (cityEl) cityEl.value = cfg.city || '';
            if (radiusEl) radiusEl.value = cfg.searchRadius || '';
            initializeChainWithConfig(cfg.categories || [], cfg.links || []);
            schedulePreviewUpdate(50);
        };
        item.addEventListener('click', load);
        item.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                load();
            }
        });

        container.appendChild(item);
    });
}

function addCategoryRow(catName = '') {
    const container = document.getElementById('categoriesContainer');
    const index = categoryChain.length;
    const options = arguments.length > 1 ? (arguments[1] || {}) : {};
    const initialMode = options.mode || 'list';
    const autoLink = options.autoLink !== false;
    
    const row = document.createElement('div');
    row.className = 'mb-3';
    row.id = `cat-row-${index}`;
    row.style.position = 'relative';
    
    const boxHtml = `
        <div class="card border-0 shadow-sm category-card">
            <div class="card-body p-4">
                <div class="d-flex align-items-start justify-content-between gap-3">
                    <div class="flex-grow-1">
                        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
                            <div style="width: 8px; height: 8px; background: ${getCategoryColor(index)}; border-radius: 50%;"></div>
                            <label class="form-label fw-bold mb-0" style="font-size: 0.95rem;">Luogo ${index + 1}</label>
                        </div>
                        <div class="input-group input-group-sm">
                            <input 
                                type="text" 
                                class="form-control category-name" 
                                value="${catName}" 
                                placeholder="Es. Ristorante, Hotel, Farmacia..."
                                list="categoriesList"
                                autocomplete="off"
                                data-index="${index}"
                                style="font-size: 0.95rem; padding: 8px 12px;">
                        </div>
                        <small class="text-muted d-block mt-2 mode-info-${index}" style="font-size: 0.85rem;"></small>
                    </div>
	                    <button type="button" class="btn btn-sm btn-outline-danger" 
	                        onclick="removeCategoryByIndex(${index})" 
	                        title="Rimuovi questo luogo"
	                        style="padding: 6px 10px;">
	                        ✕
	                    </button>
                </div>
            </div>
        </div>
    `;
    
    row.innerHTML = boxHtml;
    row.dataset.index = index;
    row.dataset.mode = initialMode;
    container.appendChild(row);

    categoryChain.push({
        name: catName,
        mode: initialMode
    });
    
    chainCount++;

    // Special options + auto mode detection + sync (usato dai modali link)
    const input = row.querySelector('.category-name');
    if (input) {
        const sync = () => {
            try {
                if (categoryChain[index]) {
                    categoryChain[index].name = (input.value || '').trim();
                    categoryChain[index].mode = row.dataset.mode || initialMode;
                }
            } catch (e) {}
        };
        input.addEventListener('input', sync);
        input.addEventListener('change', sync);

        input.addEventListener('change', () => handleCategorySpecialSelection(index));
        input.addEventListener('input', () => handleCategoryModeAuto(index));
    }

    // Setup UI per modalità manuale
    if (initialMode === 'manual') {
        const input = row.querySelector('.category-name');
        const modeInfo = row.querySelector(`.mode-info-${index}`);
        try {
            input?.removeAttribute('list');
            if (input) input.placeholder = 'Es. amenity=parking | shop=supermarket';
            if (modeInfo) modeInfo.textContent = 'Modalità manuale (tag OSM)';
        } catch (e) {}
    }

    // Auto-crea link alla categoria precedente (ma senza valori predefiniti)
    if (autoLink && index > 0) {
        const prevIdx = index - 1;
        const linkKey = `${prevIdx}-${index}`;
        if (!links[linkKey]) {
            links[linkKey] = {
                minDist: '',
                maxDist: '',
                mode: 'nearest'
            };
            renderAllLinks();
        }
    }
    
    updateRemoveCategoryButton();
}

function setCategoryRowMode(index, mode) {
    const row = document.getElementById(`cat-row-${index}`);
    if (!row) return;
    const input = row.querySelector('.category-name');
    const modeInfo = row.querySelector(`.mode-info-${index}`);

    row.dataset.mode = mode;
    try {
        if (categoryChain[index]) categoryChain[index].mode = mode;
    } catch (e) {}
    if (!input) return;

    if (mode === 'manual') {
        input.removeAttribute('list');
        input.placeholder = 'Es. amenity=parking | shop=supermarket';
        if (modeInfo) modeInfo.textContent = 'Modalità manuale (tag OSM)';
    } else {
        input.setAttribute('list', 'categoriesList');
        input.placeholder = 'Es. Ristorante, Hotel, Farmacia...';
        if (modeInfo) modeInfo.textContent = '';
    }
}

function handleCategoryModeAuto(index) {
    const row = document.getElementById(`cat-row-${index}`);
    if (!row) return;
    const input = row.querySelector('.category-name');
    if (!input) return;
    const v = (input.value || '').trim();
    if (!v) return;

    // Se l'utente scrive una tag completa, passa in manuale
    if (v.includes('=') || v.includes('|')) {
        if (row.dataset.mode !== 'manual') setCategoryRowMode(index, 'manual');
        return;
    }

    // Se seleziona un valore dalla lista, torna in list
    if (row.dataset.mode === 'manual') {
        if (allCategories.includes(v) && v !== 'Aggiungi brand' && v !== 'Tag OSM personalizzato') {
            setCategoryRowMode(index, 'list');
        }
    }
}

function handleCategorySpecialSelection(index) {
    const row = document.getElementById(`cat-row-${index}`);
    if (!row) return;
    const input = row.querySelector('.category-name');
    if (!input) return;
    const v = (input.value || '').trim();

    if (v === 'Aggiungi brand') {
        openBrandModal(index);
        return;
    }
    if (v === 'Tag OSM personalizzato') {
        setCategoryRowMode(index, 'manual');
        input.value = '';
        input.focus();
        return;
    }
}

function openBrandModal(index) {
    // Rimuovi modale vecchia se esiste
    let existing = document.getElementById('brandModal');
    if (existing) {
        const bs = bootstrap.Modal.getInstance(existing);
        if (bs) bs.dispose();
        existing.remove();
    }

    const html = `
    <div class="modal fade" id="brandModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Cerca per brand</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
          </div>
          <div class="modal-body">
            <label class="form-label fw-bold">Nome brand</label>
            <input type="text" id="brandNameInput" class="form-control" placeholder='Es. McDonald&apos;s' autocomplete="off">
            <div class="text-muted small mt-2">Verrà usata la tag <code>brand=...</code></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Annulla</button>
            <button type="button" class="btn btn-primary" id="brandConfirmBtn">Applica</button>
          </div>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    const modalEl = document.getElementById('brandModal');
    const modal = new bootstrap.Modal(modalEl, { backdrop: 'static', keyboard: false });
    modal.show();

    setTimeout(() => {
        const inp = document.getElementById('brandNameInput');
        inp?.focus();
        document.getElementById('brandConfirmBtn')?.addEventListener('click', () => {
            const brand = (document.getElementById('brandNameInput')?.value || '').trim();
            if (!brand) {
                alert('Inserisci un nome brand.');
                return;
            }
            const row = document.getElementById(`cat-row-${index}`);
            const input = row?.querySelector('.category-name');
            if (!input) return;
            setCategoryRowMode(index, 'manual');
            input.value = `brand=${brand}`;
            modal.hide();
        });
    }, 0);

    modalEl.addEventListener('hidden.bs.modal', () => {
        try { modalEl.remove(); } catch (e) {}
    });
}

function removeCategoryByIndex(index) {
    const container = document.getElementById('categoriesContainer');
    const row = document.getElementById(`cat-row-${index}`);
    
    if (row) row.remove();
    
    // Rimuovi link associati a questa categoria
    Object.keys(links).forEach(key => {
        const [from, to] = key.split('-').map(Number);
        if (from === index || to === index) {
            delete links[key];
            const linkEl = document.getElementById(`link-${key}`);
            if (linkEl) linkEl.remove();
        }
    });
    
    rebuildChain();
}

function removeCategory() {
    if (chainCount > 1) {
        removeCategoryByIndex(chainCount - 1);
    }
}

function updateRemoveCategoryButton() {
    // Pulsante rimosso (si usa la X sui box)
    return;
}

function addCategory() {
    addCategoryRow();
    updateRemoveCategoryButton();
}

function toggleManualMode(index) {
    const row = document.getElementById(`cat-row-${index}`);
    if (!row) return;
    
    const currentMode = row.dataset.mode || 'list';
    const newMode = currentMode === 'list' ? 'manual' : 'list';
    setCategoryRowMode(index, newMode);
    const input = row.querySelector('.category-name');
    if (input) {
        input.value = '';
        input.focus();
    }
}

function rebuildChain() {
    const container = document.getElementById('categoriesContainer');
    const cats = Array.from(container.querySelectorAll('.category-name')).map(input => ({
        name: input.value,
        mode: input.closest('[id^="cat-row-"]').dataset.mode || 'list'
    }));
    
    container.innerHTML = '';
    categoryChain = [];
    chainCount = 0;
    links = {};
    
    cats.forEach(cat => addCategoryRow(cat.name));
}

// Gestione collegamenti tra luoghi
function addLink() {
    if (categoryChain.length < 2) {
        alert("Devi avere almeno 2 luoghi per creare un collegamento.");
        return;
    }
    showLinkModal();
}

function showLinkModal() {
    // Rimuovi modale vecchia se esiste
    let existingModal = document.getElementById('linkModal');
    if (existingModal) {
        const bsModal = bootstrap.Modal.getInstance(existingModal);
        if (bsModal) bsModal.dispose();
        existingModal.remove();
    }
    
    let modalHtml = `
    <div class="modal fade" id="linkModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
	                    <h5 class="modal-title" id="linkModalTitle">Crea collegamento tra luoghi</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
                </div>
                <div class="modal-body">
                    <div class="mb-3">
	                        <label class="form-label fw-bold">Da luogo:</label>
                        <select id="linkFromCat" class="form-select">
    `;
    
    categoryChain.forEach((cat, idx) => {
        modalHtml += `<option value="${idx}">${idx + 1}</option>`;
    });
    
    modalHtml += `
                        </select>
                    </div>
                    <div class="mb-3">
	                        <label class="form-label fw-bold">A luogo:</label>
                        <select id="linkToCat" class="form-select">
    `;
    
    categoryChain.forEach((cat, idx) => {
        const selected = idx === 1 ? 'selected' : '';
        modalHtml += `<option value="${idx}" ${selected}>${idx + 1}</option>`;
    });
    
    modalHtml += `
                        </select>
                    </div>

                    <div class="mb-3">
                        <label class="form-label fw-bold">Modalità</label>
                        <div class="btn-group w-100" role="group">
                            <input type="radio" class="btn-check" name="linkMode" id="modeNearest" value="nearest" checked>
                            <label class="btn btn-outline-primary" for="modeNearest">Vicino</label>
                            
                            <input type="radio" class="btn-check" name="linkMode" id="modeFarthest" value="farthest">
                            <label class="btn btn-outline-primary" for="modeFarthest">Lontano</label>
                            
                            <input type="radio" class="btn-check" name="linkMode" id="modeRange" value="range">
                            <label class="btn btn-outline-primary" for="modeRange">Avanzata</label>
                        </div>
                        <small class="text-muted d-block mt-2">
                            <span id="modeHelp"><strong>Vicino</strong>: distanza massima tra i punti</span>
                        </small>
                    </div>

                    <div id="distanceFields" class="row g-2">
                        <div class="col-12">
                            <label class="form-label fw-bold" id="linkValueLabel">Massima Distanza (m):</label>
                            <input type="number" id="linkValue" class="form-control" value="" min="0" step="10" placeholder="Es: 500">
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Annulla</button>
	                    <button type="button" class="btn btn-primary" onclick="confirmAddLink()">Aggiungi collegamento</button>
                </div>
            </div>
        </div>
    </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Aggiungi event listeners per le modalità
    const modeRadios = document.querySelectorAll('input[name="linkMode"]');
    modeRadios.forEach(radio => {
        radio.addEventListener('change', updateLinkModeUI);
    });
    
    // Aggiungi event listeners ai dropdown per aggiornare i label in tempo reale
    const fromCatSelect = document.getElementById('linkFromCat');
    const toCatSelect = document.getElementById('linkToCat');
    fromCatSelect.addEventListener('change', updateLinkModeUI);
    toCatSelect.addEventListener('change', () => {
        updateLinkModeUI();
        updateLinkModalTitle();
    });
    fromCatSelect.addEventListener('change', () => {
        updateLinkModeUI();
        updateLinkModalTitle();
    });
    
    // Mostra modale
    const modal = new bootstrap.Modal(document.getElementById('linkModal'), {
        backdrop: 'static',
        keyboard: false
    });
    modal.show();
}

function updateLinkModalTitle() {
    const titleEl = document.getElementById('linkModalTitle');
    if (!titleEl) return;
    
    const fromIdx = parseInt(document.getElementById('linkFromCat')?.value) || 0;
    const toIdx = parseInt(document.getElementById('linkToCat')?.value) || 1;
    const fromName = categoryChain[fromIdx]?.name || `Cat ${fromIdx + 1}`;
    const toName = categoryChain[toIdx]?.name || `Cat ${toIdx + 1}`;
    
    titleEl.textContent = `${fromName} → ${toName}`;
}

function showLinkModalWithValues(fromIdx, toIdx, mode, minDist, maxDist) {
    // Rimuovi modale vecchia se esiste
    let existingModal = document.getElementById('linkModal');
    if (existingModal) {
        const bsModal = bootstrap.Modal.getInstance(existingModal);
        if (bsModal) bsModal.dispose();
        existingModal.remove();
    }
    
    let modalHtml = `
    <div class="modal fade" id="linkModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="linkModalTitle">Modifica collegamento tra luoghi</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
                </div>
                <div class="modal-body">
                    <div class="mb-3">
                        <label class="form-label fw-bold">Da luogo:</label>
                        <select id="linkFromCat" class="form-select">
    `;
    
    categoryChain.forEach((cat, idx) => {
        const selected = idx === fromIdx ? 'selected' : '';
        modalHtml += `<option value="${idx}" ${selected}>Luogo ${idx + 1}: ${cat.name || '(vuoto)'}</option>`;
    });
    
    modalHtml += `
                        </select>
                    </div>
                    <div class="mb-3">
                        <label class="form-label fw-bold">A luogo:</label>
                        <select id="linkToCat" class="form-select">
    `;
    
    categoryChain.forEach((cat, idx) => {
        const selected = idx === toIdx ? 'selected' : '';
        modalHtml += `<option value="${idx}" ${selected}>Luogo ${idx + 1}: ${cat.name || '(vuoto)'}</option>`;
    });
    
    modalHtml += `
                        </select>
                    </div>

                    <div class="mb-3">
                        <label class="form-label fw-bold">Modalità</label>
                        <div class="btn-group w-100" role="group">
                            <input type="radio" class="btn-check" name="linkMode" id="modeNearest" value="nearest" ${mode === 'nearest' ? 'checked' : ''}>
                            <label class="btn btn-outline-primary" for="modeNearest">Vicino</label>
                            
                            <input type="radio" class="btn-check" name="linkMode" id="modeFarthest" value="farthest" ${mode === 'farthest' ? 'checked' : ''}>
                            <label class="btn btn-outline-primary" for="modeFarthest">Lontano</label>
                            
                            <input type="radio" class="btn-check" name="linkMode" id="modeRange" value="range" ${mode === 'range' ? 'checked' : ''}>
                            <label class="btn btn-outline-primary" for="modeRange">Avanzata</label>
                        </div>
                        <small class="text-muted d-block mt-2">
                            <span id="modeHelp">Info modalità</span>
                        </small>
                    </div>

                    <div id="distanceFields" class="row g-2"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Annulla</button>
                    <button type="button" class="btn btn-primary" onclick="confirmAddLink()">Salva collegamento</button>
                </div>
            </div>
        </div>
    </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Aggiungi event listeners per le modalità
    const modeRadios = document.querySelectorAll('input[name="linkMode"]');
    modeRadios.forEach(radio => {
        radio.addEventListener('change', updateLinkModeUI);
    });
    
    // Aggiungi event listeners ai dropdown per aggiornare i label in tempo reale
    const fromCatSelect = document.getElementById('linkFromCat');
    const toCatSelect = document.getElementById('linkToCat');
    fromCatSelect.addEventListener('change', updateLinkModeUI);
    toCatSelect.addEventListener('change', updateLinkModeUI);
    
    // Aggiorna UI per mostrare i campi giusti
    updateLinkModeUI();
    
    // Imposta i valori nei campi dopo un breve delay
    setTimeout(() => {
        if (mode === 'nearest') {
            document.getElementById('linkValue').value = maxDist;
        } else if (mode === 'farthest') {
            document.getElementById('linkValue').value = minDist;
        } else {
            document.getElementById('linkMin').value = minDist;
            document.getElementById('linkMax').value = maxDist;
        }
    }, 50);
    
    // Mostra modale
    const modal = new bootstrap.Modal(document.getElementById('linkModal'), {
        backdrop: 'static',
        keyboard: false
    });
    modal.show();
}

function updateLinkModeUI() {
    const mode = document.querySelector('input[name="linkMode"]:checked').value;
    const distFields = document.getElementById('distanceFields');
    const modeHelp = document.getElementById('modeHelp');
    
    // Prendi i nomi delle categorie dal modale
    const fromIdx = parseInt(document.getElementById('linkFromCat').value);
    const toIdx = parseInt(document.getElementById('linkToCat').value);
    const fromName = categoryChain[fromIdx]?.name || `Luogo ${fromIdx + 1}`;
    const toName = categoryChain[toIdx]?.name || `Luogo ${toIdx + 1}`;

    
    distFields.innerHTML = '';
    
    if (mode === 'nearest') {
        modeHelp.innerHTML = '<strong>Vicino</strong>: distanza massima tra i punti';
        distFields.innerHTML = `
            <div class="col-12">
                <label class="form-label fw-bold">${fromName} entro N metri da ${toName}:</label>
                <input type="number" id="linkValue" class="form-control" placeholder="Es: 500" min="0" step="10">
            </div>
        `;
    } else if (mode === 'farthest') {
        modeHelp.innerHTML = '<strong>Lontano</strong>: distanza minima dai punti (dal più vicino)';
        distFields.innerHTML = `
            <div class="col-12">
                <label class="form-label fw-bold">${fromName} almeno N metri da ${toName}:</label>
                <input type="number" id="linkValue" class="form-control" placeholder="Es: 1000" min="0" step="10">
            </div>
        `;
    } else {
        modeHelp.innerHTML = '<strong>Avanzata</strong>: distanza tra min e max (dal più vicino)';
        distFields.innerHTML = `
            <div class="col-6">
                <label class="form-label fw-bold">Min ${fromName} da ${toName}:</label>
                <input type="number" id="linkMin" class="form-control" placeholder="Es: 500" min="0" step="10">
            </div>
            <div class="col-6">
                <label class="form-label fw-bold">Max ${fromName} da ${toName}:</label>
                <input type="number" id="linkMax" class="form-control" placeholder="Es: 2000" min="0" step="10">
            </div>
        `;
    }
}

function confirmAddLink() {
    const fromCat = parseInt(document.getElementById('linkFromCat').value);
    const toCat = parseInt(document.getElementById('linkToCat').value);
    const mode = document.querySelector('input[name="linkMode"]:checked').value;
    
    let minDist, maxDist;
    
    if (mode === 'nearest') {
        const val = parseInt(document.getElementById('linkValue').value);
        if (!val) {
            alert("Inserisci una distanza massima.");
            return;
        }
        minDist = 0;
        maxDist = val;
    } else if (mode === 'farthest') {
        const val = parseInt(document.getElementById('linkValue').value);
        if (!val) {
            alert("Inserisci una distanza minima.");
            return;
        }
        minDist = val;
        maxDist = 999999999;
    } else {
        const min = parseInt(document.getElementById('linkMin').value);
        const max = parseInt(document.getElementById('linkMax').value);
        if (!min || !max) {
            alert("Inserisci distanza minima e massima.");
            return;
        }
        minDist = min;
        maxDist = max;
    }
    
    if (fromCat === toCat) {
        alert("Il luogo di partenza e quello di destinazione devono essere diversi.");
        return;
    }
    
    const linkKey = `${fromCat}-${toCat}`;
    
    // Verifica se il link esiste già
    if (links[linkKey]) {
        alert("Collegamento già esistente tra questi luoghi.");
        return;
    }
    
    // Chiudi modale
    const modal = bootstrap.Modal.getInstance(document.getElementById('linkModal'));
    if (modal) modal.hide();
    
    // Aggiungi il link
    links[linkKey] = { minDist, maxDist, mode };
    renderAllLinks();
}

function renderLink(fromCat, toCat, minDist, maxDist, mode = 'range') {
    let linksContainer = document.getElementById('linksContainer');
    
    if (!linksContainer) {
        const categoriesContainer = document.getElementById('categoriesContainer');
        linksContainer = document.createElement('div');
        linksContainer.id = 'linksContainer';
        linksContainer.className = 'mt-4 pt-3 border-top';
        categoriesContainer.parentNode.insertBefore(linksContainer, categoriesContainer.nextSibling);
    }
    
    const linkId = `${fromCat}-${toCat}`;
    const linkBox = document.createElement('div');
    linkBox.id = `link-${linkId}`;
    linkBox.setAttribute('data-link-id', linkId);
    linkBox.setAttribute('data-from', fromCat);
    linkBox.setAttribute('data-to', toCat);
    linkBox.setAttribute('data-mode', mode);
    linkBox.setAttribute('data-min', (minDist === '' || Number.isNaN(minDist)) ? '' : minDist);
    linkBox.setAttribute('data-max', (maxDist === '' || Number.isNaN(maxDist)) ? '' : maxDist);
    linkBox.className = 'connection-distances mb-3 p-3';
    linkBox.style.borderRadius = '6px';
    linkBox.style.borderLeft = `3px solid ${getCategoryColor(fromCat)}`;
    linkBox.style.borderRight = `3px solid ${getCategoryColor(toCat)}`;
    
    let distInputsHtml = '';
    if (mode === 'range') {
        distInputsHtml = `
            <input type="number" class="form-control dist-min-input" style="width: 100%; flex: 1;" value="${minDist ?? ''}" min="0" step="10" placeholder="Min">
            <span style="margin: 0 8px;">-</span>
            <input type="number" class="form-control dist-max-input" style="width: 100%; flex: 1;" value="${maxDist ?? ''}" min="0" step="10" placeholder="Max">
            <span style="margin-left: 8px; font-weight: 500;">m</span>
        `;
    } else if (mode === 'nearest') {
        distInputsHtml = `
            <label style="font-size: 0.9rem; margin-right: 10px; white-space: nowrap;">Max:</label>
            <input type="number" class="form-control dist-max-input" style="width: 100%; flex: 1;" value="${maxDist ?? ''}" min="0" step="10" placeholder="Distanza">
            <span style="margin-left: 8px; font-weight: 500;">m</span>
        `;
    } else {
        distInputsHtml = `
            <label style="font-size: 0.9rem; margin-right: 10px; white-space: nowrap;">Min:</label>
            <input type="number" class="form-control dist-min-input" style="width: 100%; flex: 1;" value="${minDist ?? ''}" min="0" step="10" placeholder="Distanza">
            <span style="margin-left: 8px; font-weight: 500;">m</span>
        `;
    }
    
    linkBox.innerHTML = `
        <div class="d-flex gap-3 align-items-center" style="flex-wrap: wrap;">
            <div style="flex: 0 0 auto;">
                <small class="text-muted" style="white-space: nowrap; font-size: 1rem;"><strong>${fromCat + 1}</strong> → <strong>${toCat + 1}</strong></small>
            </div>
            <select class="form-select mode-select" style="flex: 0 0 140px;">
                <option value="nearest" ${mode === 'nearest' ? 'selected' : ''}>Vicino</option>
                <option value="farthest" ${mode === 'farthest' ? 'selected' : ''}>Lontano</option>
                <option value="range" ${mode === 'range' ? 'selected' : ''}>Avanzata</option>
            </select>
            <div class="d-flex gap-2 align-items-center" style="flex: 1; min-width: 200px;">
                ${distInputsHtml}
            </div>
            <button type="button" class="btn btn-sm btn-outline-danger" style="flex: 0 0 auto;" title="Rimuovi collegamento">✕</button>
        </div>
    `;
    
    linksContainer.appendChild(linkBox);
    
    // Aggiungi event listeners
    const modeSelect = linkBox.querySelector('.mode-select');
    modeSelect.addEventListener('change', (e) => {
        updateLinkMode(linkId, e.target.value);
    });
    
    const minInput = linkBox.querySelector('.dist-min-input');
    const maxInput = linkBox.querySelector('.dist-max-input');
    const deleteBtn = linkBox.querySelector('button');
    
    if (minInput) {
        minInput.addEventListener('change', () => {
            updateLinkDistance(linkId, minInput.value, maxInput?.value || 0, mode);
        });
    }
    if (maxInput) {
        maxInput.addEventListener('change', () => {
            updateLinkDistance(linkId, minInput?.value || 0, maxInput.value, mode);
        });
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => removeLink(linkId));
    }
}

function renderAllLinks() {
    // Pulisce e renderizza tutti i link in ordine crescente (from, to)
    const linksContainer = document.getElementById('linksContainer');
    if (linksContainer) {
        linksContainer.innerHTML = '';
    }

    const keys = Object.keys(links).sort((a, b) => {
        const [a1, a2] = a.split('-').map(Number);
        const [b1, b2] = b.split('-').map(Number);
        if (a1 !== b1) return a1 - b1;
        return a2 - b2;
    });

    keys.forEach(k => {
        const [from, to] = k.split('-').map(Number);
        const entry = links[k] || {};
        renderLink(from, to, (entry.minDist ?? ''), (entry.maxDist ?? ''), entry.mode || 'range');
    });
}

function removeLink(linkId) {
    const linkBox = document.getElementById(`link-${linkId}`);
    if (linkBox) linkBox.remove();
    
    // Rimuovi dal dizionario globale
    delete links[linkId];
    
    // Rerender ordinato dei link
    renderAllLinks();
}

function updateLinkMode(linkId, newMode) {
    // Aggiorna il dizionario e ristampa tutti i link in ordine
    const entry = links[linkId];
    if (!entry) return;
    entry.mode = newMode;
    links[linkId] = entry;
    renderAllLinks();
}

function updateLinkDistance(linkId, minDist, maxDist, currentMode) {
    const entry = links[linkId];
    if (!entry) return;
    const minStr = (minDist ?? '').toString().trim();
    const maxStr = (maxDist ?? '').toString().trim();
    minDist = minStr === '' ? '' : (parseInt(minStr, 10));
    maxDist = maxStr === '' ? '' : (parseInt(maxStr, 10));
    entry.minDist = minDist;
    entry.maxDist = maxDist;
    entry.mode = currentMode || entry.mode;
    links[linkId] = entry;
    renderAllLinks();
}

function editLink(linkId) {
    const linkEl = document.querySelector(`[data-link-id="${linkId}"]`);
    if (!linkEl) return;
    
    const fromIdx = parseInt(linkEl.getAttribute('data-from'));
    const toIdx = parseInt(linkEl.getAttribute('data-to'));
    const mode = linkEl.getAttribute('data-mode') || 'range';
    const minDist = parseInt(linkEl.getAttribute('data-min')) || 0;
    const maxDist = parseInt(linkEl.getAttribute('data-max')) || 0;
    
    // Rimuovi il link
    removeLink(linkId);
    delete links[linkId];
    
    // Apri modale con i valori precompilati
    showLinkModalWithValues(fromIdx, toIdx, mode, minDist, maxDist);
}

function quickEditDist(linkId, mode) {
    const linkEl = document.querySelector(`[data-link-id="${linkId}"]`);
    if (!linkEl) return;
    
    const minDist = parseInt(linkEl.getAttribute('data-min')) || 0;
    const maxDist = parseInt(linkEl.getAttribute('data-max')) || 0;
    const distDisplay = linkEl.querySelector('.dist-display');
    
    let inputHtml = '';
    if (mode === 'nearest') {
        inputHtml = `<input type="number" class="form-control form-control-sm" id="quickEdit_max" value="${maxDist}" min="0" step="10" style="width: 80px;">`;
    } else if (mode === 'farthest') {
        inputHtml = `<input type="number" class="form-control form-control-sm" id="quickEdit_min" value="${minDist}" min="0" step="10" style="width: 80px;">`;
    } else {
        inputHtml = `<input type="number" class="form-control form-control-sm" id="quickEdit_min" value="${minDist}" min="0" step="10" style="width: 60px;"> - <input type="number" class="form-control form-control-sm" id="quickEdit_max" value="${maxDist}" min="0" step="10" style="width: 60px;">`;
    }
    
    distDisplay.innerHTML = inputHtml;
    
    // Focus sul primo input
    document.getElementById(mode === 'range' ? 'quickEdit_min' : 'quickEdit_max')?.focus();
    
    // Salva con Enter, annulla con Escape
    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            const newMin = parseInt(document.getElementById('quickEdit_min')?.value) || minDist;
            const newMax = parseInt(document.getElementById('quickEdit_max')?.value) || maxDist;
            
            linkEl.setAttribute('data-min', newMin);
            linkEl.setAttribute('data-max', newMax);
            
            const newLabel = mode === 'nearest' ? `Max ${newMax}m` : mode === 'farthest' ? `Min ${newMin}m` : `${newMin}-${newMax}m`;
            distDisplay.innerHTML = newLabel;
            distDisplay.style.cursor = 'pointer';
            
            // Aggiorna nel dizionario links
            links[linkId] = { minDist: newMin, maxDist: newMax, mode };
        } else if (e.key === 'Escape') {
            distDisplay.innerHTML = mode === 'nearest' ? `Max ${maxDist}m` : mode === 'farthest' ? `Min ${minDist}m` : `${minDist}-${maxDist}m`;
            distDisplay.style.cursor = 'pointer';
        }
        document.removeEventListener('keydown', handleKeyDown);
    };
    
    document.addEventListener('keydown', handleKeyDown);
}

// Gestione click bottone Avvia ricerca
document.getElementById('goBtn').onclick = async () => {
    const btn = document.getElementById('goBtn');
    const formCard = document.getElementById('formCard');
    const mapProgressOverlay = document.getElementById('mapProgressOverlay');
    const resultSection = document.getElementById('resultSection');
    const errorAlert = document.getElementById('errorAlert');
    
    if (currentEventSource) {
        currentEventSource.close();
    }
    
    errorAlert.classList.add('d-none');
    resultSection.classList.add('d-none');
    formCard.classList.remove('d-none');
    setFiltersEnabled(false);
    mapProgressOverlay?.classList.remove('d-none');
    btn.disabled = true;
    btn.textContent = "Ricerca in corso...";

    // Raccogli i dati della catena di categorie
    const city = document.getElementById('city').value.trim();
    const searchRadius = document.getElementById('searchRadius').value;
    
    // Raccogli le categorie
    const categoryInputs = document.querySelectorAll('.category-name');
    const categories = [];
    const linksList = []; // Array di link con (from, to, minDist, maxDist)
    
    categoryInputs.forEach((input, idx) => {
        const row = input.closest('[id^="cat-row-"]');
        categories.push({
            name: input.value.trim(),
            mode: row.dataset.mode || 'list'
        });
    });
    
    // Raccogli i link definiti manualmente dall'utente (dall'oggetto globale 'links')
    const linksContainer = document.getElementById('linksContainer');
    if (linksContainer) {
        linksContainer.querySelectorAll('[data-link-id]').forEach(linkEl => {
            const fromIdx = parseInt(linkEl.getAttribute('data-from'));
            const toIdx = parseInt(linkEl.getAttribute('data-to'));
            const mode = linkEl.getAttribute('data-mode') || 'range';
            const minDistAttr = linkEl.getAttribute('data-min');
            const maxDistAttr = linkEl.getAttribute('data-max');
            const minDist = minDistAttr === null ? NaN : parseInt(minDistAttr, 10);
            const maxDist = maxDistAttr === null ? NaN : parseInt(maxDistAttr, 10);
            
            linksList.push({
                from: fromIdx,
                to: toIdx,
                mode: mode,
                minDist: minDist,
                maxDist: maxDist
            });
        });
    }

    // Validazione
    if (!city) {
        showError("Compila la città.");
        setFiltersEnabled(true);
        return;
    }
    
    if (categories.length === 0 || categories.some(c => !c.name)) {
        showError("Aggiungi almeno un luogo valido.");
        setFiltersEnabled(true);
        return;
    }
    
    // Verifica che ci siano almeno (n-1) collegamenti per n luoghi
    const neededLinks = Math.max(0, categories.length - 1);
    if (linksList.length < neededLinks) {
        showError(`Devi definire almeno ${neededLinks} collegamenti (attualmente ${linksList.length}).`);
        setFiltersEnabled(true);
        return;
    }

    // Validazione distanze collegamenti (senza default)
    for (const link of linksList) {
        if (!Number.isFinite(link.from) || !Number.isFinite(link.to)) {
            showError("Almeno un collegamento non è valido (luoghi non selezionati correttamente).");
            setFiltersEnabled(true);
            return;
        }
        if (link.mode === 'nearest') {
            if (!Number.isFinite(link.maxDist) || link.maxDist <= 0) {
                showError("Inserisci una distanza massima valida per tutti i collegamenti in modalità 'Vicino'.");
                setFiltersEnabled(true);
                return;
            }
        } else if (link.mode === 'farthest') {
            if (!Number.isFinite(link.minDist) || link.minDist <= 0) {
                showError("Inserisci una distanza minima valida per tutti i collegamenti in modalità 'Lontano'.");
                setFiltersEnabled(true);
                return;
            }
        } else {
            if (!Number.isFinite(link.minDist) || !Number.isFinite(link.maxDist) || link.minDist < 0 || link.maxDist <= 0) {
                showError("Inserisci distanze min/max valide per tutti i collegamenti in modalità 'Avanzata'.");
                setFiltersEnabled(true);
                return;
            }
            if (link.minDist > link.maxDist) {
                showError("In un collegamento 'Avanzata' la distanza minima non può superare la massima.");
                setFiltersEnabled(true);
                return;
            }
        }
    }

    // Costruisci URL per catena di categorie
    const searchConfig = {
        city,
        searchRadius: parseInt(searchRadius, 10) || searchRadius,
        categories: categories.map(c => ({ name: c.name, mode: c.mode })),
        links: linksList.map(l => ({ from: l.from, to: l.to, mode: l.mode, minDist: l.minDist, maxDist: l.maxDist }))
    };
    lastSearchConfig = searchConfig;

    const params = new URLSearchParams();
    params.append('city', city);
    params.append('search_radius', searchRadius);
    params.append('chain_mode', 'true');
    params.append('chain_length', categories.length);
    
    categories.forEach((cat, idx) => {
        params.append(`chain_${idx}_name`, cat.name);
        params.append(`chain_${idx}_mode`, cat.mode);
    });
    
    // Invia i link con indici (from/to) e modalità
    linksList.forEach((link, idx) => {
        params.append(`link_${idx}_from`, link.from);
        params.append(`link_${idx}_to`, link.to);
        params.append(`link_${idx}_mode`, link.mode);
        
        if (link.mode === 'nearest') {
            params.append(`link_${idx}_value`, link.maxDist);
        } else if (link.mode === 'farthest') {
            params.append(`link_${idx}_value`, link.minDist);
        } else {
            params.append(`link_${idx}_min`, link.minDist);
            params.append(`link_${idx}_max`, link.maxDist);
        }
    });
    
    currentEventSource = new EventSource('/search_stream?' + params.toString());

    const pBarO = document.getElementById('progressBarOverlay');
    const statusTextO = document.getElementById('statusTextOverlay');
    const detailsTextO = document.getElementById('detailsTextOverlay');
    const progressPctO = document.getElementById('progressPctOverlay');

    currentEventSource.onmessage = function(ev) {
        try {
            const msg = JSON.parse(ev.data);

            if (msg.type === 'progress') {
                const pct = Math.min(msg.progress || 0, 99);
                if (pBarO) pBarO.style.width = pct + '%';
                if (progressPctO) progressPctO.textContent = pct + '%';
                if (statusTextO) statusTextO.textContent = msg.message || 'Elaborazione...';
                
                let det = [];
                if (msg.counts) {
                    Object.entries(msg.counts).forEach(([name, count]) => {
                        if (count > 0) det.push(`${name}: ${count}`);
                    });
                }
                if (msg.found !== undefined) det.push(`Connessioni: ${msg.found}`);
                if (detailsTextO) detailsTextO.textContent = det.join(' • ');

            } else if (msg.type === 'done') {
                currentEventSource.close();
                if (pBarO) pBarO.style.width = '100%';
                if (progressPctO) progressPctO.textContent = '100%';
                if (statusTextO) statusTextO.textContent = 'Ricerca completata';
                if (detailsTextO) detailsTextO.textContent = '';
                
                setTimeout(() => {
                    handleDone(msg, city, searchRadius, categories, msg.details);
                }, 800);

            } else if (msg.type === 'error') {
                currentEventSource.close();
                showError(msg.message);
                setFiltersEnabled(true);
            }
        } catch (e) {
            console.error('Errore parsing:', e);
        }
    };

    currentEventSource.onerror = function() {
        currentEventSource.close();
        showError("Connessione interrotta o timeout. Riprova.");
        setFiltersEnabled(true);
    };

    function showError(msg) {
        mapProgressOverlay?.classList.add('d-none');
        btn.disabled = false;
        btn.textContent = "Avvia ricerca";
        document.getElementById('errorText').textContent = msg;
        errorAlert.classList.remove('d-none');
    }

    function handleDone(result, city, radius, pairDefinitions, details) {
        mapProgressOverlay?.classList.add('d-none');
        resultSection.classList.remove('d-none');
        // Nascondi filtri: si modificano con il bottone "Modifica"
        formCard.classList.add('d-none');
        
        const chains = Array.isArray(result?.chains) ? result.chains : [];
        const edges = Array.isArray(result?.pairs) ? result.pairs : [];

        // Conteggio: se ho catene, mostra numero catene; altrimenti numero edge
        document.getElementById('pairCount').textContent = '…';
        document.getElementById('resultCity').textContent = city;
        
        let detailsHtml = '';
        if (details) {
            const detailsList = Object.entries(details)
                .map(([name, count]) => `${name}: ${count}`)
                .join(' • ');
            detailsHtml = `Raggio ricerca: ${radius}m • ${detailsList}`;
        }
        document.getElementById('resultDetails').innerHTML = detailsHtml;
        
        btn.disabled = false;
        btn.textContent = "Avvia ricerca";

        // Aggiorna conteggio appena prima del render mappa (può essere raffinato in initMap)
        const count = chains.length > 0 ? chains.length : edges.length;
        document.getElementById('pairCount').textContent = count;

        // Testo singolare/plurale e "a <città>"
        const summaryEl = document.getElementById('resultSummary');
        if (summaryEl) {
            const verb = count === 1 ? 'Trovata' : 'Trovate';
            const noun = count === 1 ? 'connessione' : 'connessioni';
            summaryEl.innerHTML = `${verb} <strong id="pairCount">${count}</strong> ${noun} a <strong id="resultCity">${city}</strong>`;
        }

        renderResultsList(result);
        lastSearchResult = result;
        saveHistoryEntry(lastSearchConfig, result);
        initMap(result, pairDefinitions);
    }
};

function initMap(result, pairDefinitions) {
    const chains = Array.isArray(result?.chains) ? result.chains : [];
    const edges = Array.isArray(result?.pairs) ? result.pairs : [];

    ensureMap();
    
    setTimeout(() => {
        map.invalidateSize();
    }, 100);

    // Quando mostriamo risultati, togli la preview del raggio (la ripristiniamo in resetForm)
    hidePreviewLayers();

    markers.forEach(m => map.removeLayer(m));
    lines.forEach(l => map.removeLayer(l));
    markers = [];
    lines = [];

    stopAutoplay();
    removeNavigatorControl();
    resultNavigator.chains = [];
    resultNavigator.index = 0;

    if (chains.length === 0 && edges.length === 0) {
        map.setView([41.9028, 12.4964], 5);
        L.popup()
            .setLatLng([41.9028, 12.4964])
            .setContent('<b>Nessuna connessione trovata</b><br>Prova con distanze maggiori o luoghi diversi.')
            .openOn(map);
        return;
    }

    // Conteggio: preferisci catene (connessioni indipendenti), fallback a edge
    try {
        document.getElementById('pairCount').textContent = chains.length > 0 ? chains.length : edges.length;
    } catch (e) {}

    let bounds = [];

    // Raccogli tutti i punti UNICI dalle catene (così i marker appaiono anche con >2 categorie)
    const uniquePointsMap = new Map(); // key: "lat_lon" -> {lat, lon, name, cat, color}
    const categoryIndex = {};
    const seenCategories = [];

    if (chains.length > 0) {
        chains.forEach(chain => {
            (chain.points || []).forEach(pt => {
                const cat = pt.category || '(luogo)';
                if (!categoryIndex.hasOwnProperty(cat)) {
                    categoryIndex[cat] = seenCategories.length;
                    seenCategories.push(cat);
                }
                const key = `${pt.lat.toFixed(6)}_${pt.lon.toFixed(6)}_${cat}`;
                if (!uniquePointsMap.has(key)) {
                    uniquePointsMap.set(key, {
                        lat: pt.lat,
                        lon: pt.lon,
                        name: pt.name,
                        cat,
                        color: getCategoryColor(categoryIndex[cat] || 0)
                    });
                }
            });
        });
    } else {
        // Fallback: se non arrivano catene dal backend, usa gli edge
        edges.forEach(p => {
            if (!categoryIndex.hasOwnProperty(p.cat1)) {
                categoryIndex[p.cat1] = seenCategories.length;
                seenCategories.push(p.cat1);
            }
            if (!categoryIndex.hasOwnProperty(p.cat2)) {
                categoryIndex[p.cat2] = seenCategories.length;
                seenCategories.push(p.cat2);
            }
            const key1 = `${p.p1.lat.toFixed(6)}_${p.p1.lon.toFixed(6)}_${p.cat1}`;
            if (!uniquePointsMap.has(key1)) {
                uniquePointsMap.set(key1, {
                    lat: p.p1.lat,
                    lon: p.p1.lon,
                    name: p.p1.name,
                    cat: p.cat1,
                    color: getCategoryColor(categoryIndex[p.cat1] || 0)
                });
            }
            const key2 = `${p.p2.lat.toFixed(6)}_${p.p2.lon.toFixed(6)}_${p.cat2}`;
            if (!uniquePointsMap.has(key2)) {
                uniquePointsMap.set(key2, {
                    lat: p.p2.lat,
                    lon: p.p2.lon,
                    name: p.p2.name,
                    cat: p.cat2,
                    color: getCategoryColor(categoryIndex[p.cat2] || 1)
                });
            }
        });
    }
    
    // Crea marker per ogni punto unico
    uniquePointsMap.forEach((point) => {
        const m = L.circleMarker([point.lat, point.lon], {
            color: point.color,
            radius: 7,
            fillOpacity: 0.9,
            weight: 2
        }).addTo(map);
        
        const googleMapsUrl = `https://www.google.com/maps/?q=${point.lat},${point.lon}`;

        const popupContent = `<div style="font-size: 0.85rem; min-width: 200px;">
            <b>${point.name || 'Luogo'}</b><br>
            <small class="poi-cat">${point.cat}</small><br>
            <code class="poi-coord" style="font-size: 0.75rem;">
                ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}
            </code><br>
            <a href="${googleMapsUrl}" target="_blank" class="poi-link" style="text-decoration: none; font-size: 0.8rem;">
                Apri in Google Maps
            </a>
        </div>`;
        
        m.bindPopup(popupContent);
        markers.push(m);
        bounds.push([point.lat, point.lon]);
    });
    
    // Disegna linee: preferisci edge dal backend (vincoli rispettati), fallback a polilinea per catena
    if (edges.length > 0) {
        edges.forEach(p => {
            const a = [p.p1.lat, p.p1.lon];
            const b = [p.p2.lat, p.p2.lon];
            const line = L.polyline([a, b], {
                color: '#666666',
                weight: 2,
                opacity: 0.5,
                dashArray: '5, 5'
            }).addTo(map);
            try {
                const label = `${p.cat1} → ${p.cat2}: ${p.dist_m} m`;
                line.bindTooltip(label, { sticky: true, direction: 'top', opacity: 0.9 });
            } catch (e) {}
            // Metadata per evidenziare/mostrare tooltip quando si scorre tra le catene
            line.__chainId = (p.chain_id !== undefined && p.chain_id !== null) ? p.chain_id : null;
            lines.push(line);
        });
    } else if (chains.length > 0) {
        chains.forEach(chain => {
            const pts = (chain.points || []).map(p => [p.lat, p.lon]);
            if (pts.length < 2) return;
            const line = L.polyline(pts, {
                color: '#666666',
                weight: 2,
                opacity: 0.5,
                dashArray: '5, 5'
            }).addTo(map);
            lines.push(line);
        });
    }

    if (bounds.length) {
        map.fitBounds(L.latLngBounds(bounds), {
            padding: [60, 60],
            maxZoom: 16
        });
    }

    // Se ci sono catene, abilita navigazione e autoplay (scorrimento) tra risultati
    if (chains.length > 0) {
        resultNavigator.chains = chains;
        resultNavigator.index = 0;
        addNavigatorControl();
        // Porta subito al primo risultato (senza richiedere zoom manuale)
        setTimeout(() => focusChain(0), 250);
    }
}

function resetForm() {
    document.getElementById('resultSection').classList.add('d-none');
    document.getElementById('errorAlert').classList.add('d-none');
    document.getElementById('formCard').classList.remove('d-none');
    document.getElementById('mapProgressOverlay')?.classList.add('d-none');
    setFiltersEnabled(true);

    const resultsList = document.getElementById('resultsList');
    if (resultsList) resultsList.innerHTML = '';
    
    const btn = document.getElementById('goBtn');
    btn.disabled = false;
    btn.textContent = "Avvia ricerca";
    
    if (currentEventSource) {
        try { currentEventSource.close(); } catch (e) {}
        currentEventSource = null;
    }

    // Pulisci layer risultati, ma lascia la mappa visibile
    try {
        stopAutoplay();
        removeNavigatorControl();
        markers.forEach(m => map?.removeLayer(m));
        lines.forEach(l => map?.removeLayer(l));
    } catch (e) {}
    markers = [];
    lines = [];

    // Ripristina preview se possibile
    try { renderPreview({ onlyRadius: false }); } catch (e) {}
}

function newSearch() {
    resetForm();
    // Reset filtri
    const cityEl = document.getElementById('city');
    const radiusEl = document.getElementById('searchRadius');
    if (cityEl) cityEl.value = '';
    if (radiusEl) radiusEl.value = 50000;
    initializeChain();
    clearPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function focusChain(idx) {
    if (!map || !Array.isArray(resultNavigator.chains) || resultNavigator.chains.length === 0) return;
    let targetIdx = idx;
    // Se idx corrisponde a un chain.id, converti in indice array
    try {
        const found = resultNavigator.chains.findIndex(c => (c && c.id !== undefined && c.id !== null) && c.id === idx);
        if (found >= 0) targetIdx = found;
    } catch (e) {}

    const safeIdx = ((targetIdx % resultNavigator.chains.length) + resultNavigator.chains.length) % resultNavigator.chains.length;
    resultNavigator.index = safeIdx;

    const chain = resultNavigator.chains[safeIdx];
    const pts = (chain?.points || []).filter(p => typeof p.lat === 'number' && typeof p.lon === 'number');
    if (pts.length === 0) return;

    const latLngs = pts.map(p => L.latLng(p.lat, p.lon));
    const b = L.latLngBounds(latLngs);
    map.fitBounds(b, { padding: [80, 80], maxZoom: 17 });
    updateNavigatorLabel();

    // Mostra in automatico i tooltip delle linee della catena corrente (non invasivo: si richiudono dopo poco)
    const chainId = (chain && chain.id !== undefined && chain.id !== null) ? chain.id : safeIdx;
    revealChainTooltips(chainId);
    highlightActiveResultInSidebar(chainId);
}

function nextChain() {
    if (!resultNavigator.chains || resultNavigator.chains.length === 0) return;
    focusChain(resultNavigator.index + 1);
}

function prevChain() {
    if (!resultNavigator.chains || resultNavigator.chains.length === 0) return;
    focusChain(resultNavigator.index - 1);
}

function startAutoplay() {
    if (!resultNavigator.chains || resultNavigator.chains.length === 0) return;
    stopAutoplay();
    resultNavigator.timer = setInterval(() => nextChain(), resultNavigator.intervalMs);
    updatePlayButton(true);
}

function stopAutoplay() {
    if (resultNavigator.timer) {
        clearInterval(resultNavigator.timer);
        resultNavigator.timer = null;
    }
    updatePlayButton(false);
}

function toggleAutoplay() {
    if (resultNavigator.timer) stopAutoplay();
    else startAutoplay();
}

function updateNavigatorLabel() {
    const el = document.getElementById('navStatusLabel');
    if (!el) return;
    const total = resultNavigator.chains?.length || 0;
    if (total === 0) {
        el.textContent = '';
        return;
    }
    el.textContent = `${resultNavigator.index + 1}/${total}`;
}

function updatePlayButton(isPlaying) {
    const btn = document.getElementById('navPlayBtn');
    if (!btn) return;
    btn.textContent = isPlaying ? '⏸' : '▶';
    btn.title = isPlaying ? 'Pausa' : 'Play';
}

function highlightActiveResultInSidebar(chainId) {
    const list = document.getElementById('resultsList');
    if (!list) return;
    const items = list.querySelectorAll('.result-item');
    items.forEach(it => it.classList.remove('active'));
    if (chainId === undefined || chainId === null) return;
    const active = list.querySelector(`.result-item[data-chain-id="${chainId}"]`);
    if (active) {
        active.classList.add('active');
        try {
            active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (e) {}
    }
}

function removeNavigatorControl() {
    if (resultNavigator.control && map) {
        try {
            resultNavigator.control.remove();
        } catch (e) {}
    }
    resultNavigator.control = null;
    if (resultNavigator.tooltipTimer) {
        clearTimeout(resultNavigator.tooltipTimer);
        resultNavigator.tooltipTimer = null;
    }
}

function addNavigatorControl() {
    if (!map) return;
    if (resultNavigator.control) return;

    const control = L.control({ position: 'topright' });
    control.onAdd = function() {
        const div = L.DomUtil.create('div', 'leaflet-bar map-player');

        div.innerHTML = `
            <div style="display:flex; gap:6px; align-items:center;">
                <button id="navPrevBtn" type="button" class="mp-btn" title="Precedente">⏮</button>
                <button id="navPlayBtn" type="button" class="mp-btn" title="Play">▶</button>
                <button id="navNextBtn" type="button" class="mp-btn" title="Successivo">⏭</button>
                <span id="navStatusLabel" class="mp-label"></span>
                <select id="navSpeedSel" class="mp-sel" title="Velocità">
                    <option value="2000">2s</option>
                    <option value="3000" selected>3s</option>
                    <option value="5000">5s</option>
                    <option value="8000">8s</option>
                </select>
            </div>
        `;

        // Evita che il drag/scroll della mappa venga catturato dai controlli
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        // Hook eventi
        setTimeout(() => {
            document.getElementById('navPrevBtn')?.addEventListener('click', () => {
                stopAutoplay();
                prevChain();
            });
            document.getElementById('navNextBtn')?.addEventListener('click', () => {
                stopAutoplay();
                nextChain();
            });
            document.getElementById('navPlayBtn')?.addEventListener('click', () => toggleAutoplay());
            document.getElementById('navSpeedSel')?.addEventListener('change', (e) => {
                const v = parseInt(e.target.value, 10);
                resultNavigator.intervalMs = Number.isFinite(v) ? v : 3000;
                if (resultNavigator.timer) startAutoplay(); // riavvia con nuova velocità
            });

            updateNavigatorLabel();
            updatePlayButton(false);
        }, 0);

        return div;
    };

    control.addTo(map);
    resultNavigator.control = control;
    updateNavigatorLabel();
}

function revealChainTooltips(chainId) {
    if (!map || !Array.isArray(lines) || lines.length === 0) return;

    // Reset timer precedente
    if (resultNavigator.tooltipTimer) {
        clearTimeout(resultNavigator.tooltipTimer);
        resultNavigator.tooltipTimer = null;
    }

    // Evidenzia la catena attiva e apri i tooltip relativi
    const active = [];
    lines.forEach(l => {
        const isActive = (l && l.__chainId !== null && l.__chainId !== undefined && l.__chainId === chainId);
        try {
            l.setStyle({
                opacity: isActive ? 0.85 : 0.18,
                weight: isActive ? 3 : 2
            });
        } catch (e) {}
        try {
            if (!isActive) l.closeTooltip();
        } catch (e) {}
        if (isActive) active.push(l);
    });

    // Apri solo alcuni tooltip per evitare "rumore" se ci sono molti link
    active.slice(0, 6).forEach(l => {
        try {
            l.openTooltip();
        } catch (e) {}
    });

    // Richiudi dopo un po' (durante autoplay più veloce)
    const closeAfterMs = resultNavigator.timer ? 1400 : 2200;
    resultNavigator.tooltipTimer = setTimeout(() => {
        active.slice(0, 6).forEach(l => {
            try {
                l.closeTooltip();
            } catch (e) {}
        });
        resultNavigator.tooltipTimer = null;
    }, closeAfterMs);
}
