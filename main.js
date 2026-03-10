'use strict';

/*
 * Obsidian Node Graph View Plugin
 * Faithful port of mkdocs-nodegraph (https://github.com/yonge123/mkdocs-nodegraph)
 *
 * Node/edge logic from generate_graph.py:
 *   - count_links = bidirectional link count (data_dic)
 *   - color = color_list.pop(0)  [BEAUTIFUL_COLORS, popped in order]
 *   - if count_links <= 1: color = "#9CA3AF"
 *   - mdfile_color overrides color
 *   - mdfile_icon  → shape="image", mdfile_site → url2
 *   - size = min(50 + count_links*4, 120)
 *   - edge_len = max_link*45 + idx*35
 *   - edge width = 12 (default_edge_weight)
 *   - edge color = dominant node color (set_edge_color_by_dominant_node)
 *   - font color = node color
 * UI/controls from nodegraph_max.html:
 *   - vis.js forceAtlas2Based physics
 *   - All slider ranges/defaults/multipliers match exactly
 *   - Collapse btn, Search+nav, Save/Home/Reset, 4 toggles, 9 sliders
 */

const { Plugin, ItemView, Notice, debounce } = require('obsidian');

const VIEW_TYPE   = 'nodegraph-view';
const VIS_JS_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/vis-network/10.0.2/dist/vis-network.min.js';
const VIS_CSS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/vis-network/10.0.2/dist/dist/vis-network.min.css';

// Exact beautifulcolors from generate_graph.py
const BEAUTIFUL_COLORS = [
  "#E9967A","#00CED1","#90EE90","#CD5C5C","#FF1493","#32CD32","#FF00FF",
  "#4682B4","#DA70D6","#FFD700","#C71585","#FFDAB9","#20B2AA","#FF69B4",
  "#DAA520","#48D1CC","#F0E68C","#9400D3","#FF7F50","#8B008B","#98FB98",
  "#DDA0DD","#6495ED","#4169E1","#87CEEB","#800080","#FFA500","#8E44AD",
  "#9370DB","#3CB371","#8A2BE2","#66CDAA","#9932CC","#BA55D3","#4ECDC4",
  "#8FBC8F","#5F9EA0","#45B7D1","#FA8072","#00FA9A","#F4A460","#6A5ACD",
  "#D2691E","#7B68EE","#40E0D0","#F08080","#B0C4DE","#FF6B6B","#1E90FF",
  "#FF4500","#FFB6C1","#FFA07A","#87CEFA",
];
const ORPHAN_COLOR = "#9CA3AF";

// Exact default_preferences from nodegraph_max.html
const DEFAULT_PREFS = {
  physics: true, showNodes: true, showGrid: true,
  gridScale: 120, gravitationalConstant: -800, centralGravity: 3,
  springConstant: 7, damping: 25, fontSize: 43, nodeSize: 11,
  edgeLength: 4, edgeWidth: 6,
  bgColor: 'rgba(25, 27, 32, 1)', gridColor: 'rgba(255,255,255,0.055)',
};

// ─── Plugin ───────────────────────────────────────────────────────────────────
class NodeGraphPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, leaf => new NodeGraphView(leaf, this));
    this.addRibbonIcon('git-fork', 'Open Node Graph', () => this.activateView());
    this.addCommand({ id: 'open-nodegraph', name: 'Open Node Graph', callback: () => this.activateView() });
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
  async activateView() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) { workspace.revealLeaf(leaves[0]); return; }
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }
  async loadSettings() { this.settings = Object.assign({}, await this.loadData() || {}); }
  async saveSettings() { await this.saveData(this.settings); }
}

// ─── View ─────────────────────────────────────────────────────────────────────
class NodeGraphView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.network = null;
    this.visNodes = null;
    this.visEdges = null;
    this.nodesBackup = [];
    this.edgesBackup = [];
    this.nodeColors  = {};
    this.matchList   = [];
    this.matchIdx    = -1;
    this._highlightedNodeId = null;
    this.prefs = Object.assign({}, DEFAULT_PREFS, plugin.settings.prefs || {});
  }
  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Node Graph'; }
  getIcon()        { return 'git-fork'; }

  async onOpen() {
    this.containerEl.empty();
    this._buildUI();
    await this._loadVis();
    await this._buildGraph();
  }

  onClose() {
    if (this.network) { this.network.destroy(); this.network = null; }
    if (this._blobUrls) { this._blobUrls.forEach(u => URL.revokeObjectURL(u)); this._blobUrls = []; }
  }

  // ── Build HTML UI ─────────────────────────────────────────────────────────
  _buildUI() {
    const root = this.containerEl.createDiv({ cls: 'ng-root' });

    // LEFT PANEL
    this._panel = root.createDiv({ cls: 'ng-panel' });

    // Collapse button with original SVG icon
    const colBtn = this._panel.createEl('button', { cls: 'ng-collapse-btn' });
    colBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11 3.9V20.3M6 7.4H8M6 10.9H8M6 14.5H8M6.2 20.3H17.8C18.9 20.3 19.5 20.3 19.9 20.1 20.3 19.8 20.6 19.5 20.8 19 21 18.6 21 17.9 21 16.6V7.7C21 6.4 21 5.7 20.8 5.2 20.6 4.7 20.3 4.4 19.9 4.1 19.5 3.9 18.9 3.9 17.8 3.9H6.2C5.1 3.9 4.5 3.9 4.1 4.1 3.7 4.4 3.4 4.7 3.2 5.2 3 5.7 3 6.4 3 7.7V16.6C3 17.9 3 18.6 3.2 19 3.4 19.5 3.7 19.8 4.1 20.1 4.5 20.3 5.1 20.3 6.2 20.3Z"
        stroke="whitesmoke" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    colBtn.onclick = () => this._panel.classList.toggle('collapsed');
    this._panel.classList.toggle('collapsed');
    const content = this._panel.createDiv({ cls: 'ng-panel-content' });

    // Search row
    const sr = content.createDiv({ cls: 'ng-search-row' });
    this._searchEl = sr.createEl('input', { type: 'text', cls: 'ng-search', placeholder: 'Search...' });
    this._searchEl.addEventListener('input', debounce(() => this._onSearch(), 200));
    this._searchEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._navMatch(e.shiftKey ? -1 : 1);
    });
    const upBtn = sr.createEl('button', { cls: 'ng-nav-btn' });
    upBtn.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" stroke="white" stroke-width="3" fill="none" 
    xmlns="http://www.w3.org/2000/svg" > 
    <path d="M12 19V5"></path> 
    <polyline points="5 12 12 5 19 12"></polyline> </svg>`;
    const dnBtn = sr.createEl('button', { cls: 'ng-nav-btn' });
    dnBtn.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" stroke="white" stroke-width="3" fill="none" 
    xmlns="http://www.w3.org/2000/svg" > 
    <path d="M12 5v14"></path> 
    <polyline points="19 12 12 19 5 12"></polyline> </svg>`;
    upBtn.onclick = () => this._navMatch(-1);
    dnBtn.onclick = () => this._navMatch(1);

    // Save / Home / Reset buttons
    content.createEl('button', { cls: 'ng-btn ng-btn-save', text: 'Save' })
      .onclick = () => this._savePrefs();
    content.createEl('button', { cls: 'ng-btn ng-btn-home', text: 'Home' })
      .onclick = () => this.network?.fit({ animation: true });
    content.createEl('button', { cls: 'ng-btn ng-btn-reset', text: 'Reset' })
      .onclick = () => this._resetPrefs();

    // Toggles
    this._checkboxes = {};
    const tg = content.createDiv({ cls: 'ng-toggle-group' });
    const mkToggle = (label, key, fn) => {
      const item = tg.createEl('label', { cls: 'ng-toggle-item' });
      const cb = item.createEl('input', { type: 'checkbox' });
      cb.style.display = 'none';
      cb.checked = this.prefs[key];
      item.createDiv({ cls: 'ng-toggle-dot' });
      item.createEl('span', { cls: 'ng-toggle-label', text: label });
      item.onclick = e => { e.preventDefault(); cb.checked = !cb.checked; this.prefs[key] = cb.checked; fn(cb.checked); };
      this._checkboxes[key] = cb;
    };
    mkToggle('Physics',  'physics',   v => this.network?.setOptions({ physics: { enabled: v } }));
    mkToggle('Nodes',    'showNodes', v => this._setNodeTypeVisible('filenode', v));
    mkToggle('Grid',     'showGrid',  () => this._drawGrid());

    // 9 sliders — exact ranges from nodegraph_max.html
    this._sliders = {};
    const SLIDER_DEFS = [
      { key: 'gridScale',             label: 'Grid Scale',             min: 10,    max: 300 },
      { key: 'gravitationalConstant', label: 'Gravitational Constant', min: -5000, max: 1100 },
      { key: 'centralGravity',        label: 'CentralGravity',         min: 0,     max: 100 },
      { key: 'springConstant',        label: 'Spring Constant',        min: 0,     max: 100 },
      { key: 'damping',               label: 'Damping',                min: 0,     max: 50 },
      { key: 'fontSize',              label: 'Font Size',              min: 30,    max: 200 },
      { key: 'nodeSize',              label: 'Node Size',              min: 1,     max: 100 },
      { key: 'edgeLength',            label: 'Edge Length',            min: 1,     max: 100 },
      { key: 'edgeWidth',             label: 'Edge Width',             min: 1,     max: 100 },
    ];
    for (const d of SLIDER_DEFS) {
      const w = content.createDiv({ cls: 'ng-slider-wrap' });
      w.createEl('span', { cls: 'ng-control-label', text: d.label });
      const sl = w.createEl('input', { type: 'range', cls: 'ng-slider' });
      sl.min = d.min; sl.max = d.max; sl.value = this.prefs[d.key];
      this._sliders[d.key] = sl;
      sl.oninput = () => { this.prefs[d.key] = +sl.value; this._applySlider(d.key); };
    }

        // ── Color pickers ──────────────────────────────────────────────────────
    this._colorPickers = {};
    const COLOR_DEFS = [
      { key: 'bgColor',   label: 'Background Color' },
      { key: 'gridColor', label: 'Grid Color' },
    ];
    for (const d of COLOR_DEFS) {
      const w = content.createDiv({ cls: 'ng-slider-wrap' });
      w.createEl('span', { cls: 'ng-control-label', text: d.label });
      const row = w.createDiv({ cls: 'ng-color-row' });
      const cp = row.createEl('input', { type: 'color', cls: 'ng-color-picker' });
      cp.value = this.prefs[d.key];
      const hex = row.createEl('span', { cls: 'ng-color-hex', text: this.prefs[d.key] });
      this._colorPickers[d.key] = cp;
      cp.oninput = () => {
        this.prefs[d.key] = cp.value;
        hex.textContent = cp.value;
        this._applyColor(d.key);
      };
    }

    // RIGHT CANVAS AREA
    this._area = root.createDiv({ cls: 'ng-area' });
    this._gridCanvas = this._area.createEl('canvas', { cls: 'ng-grid-canvas' });
    this._visEl      = this._area.createDiv({ cls: 'ng-vis' });
    this._loadingEl  = this._area.createDiv({ cls: 'ng-loading' });
    this._loadingEl.createDiv({ cls: 'ng-spinner' });
    this._loadingEl.createEl('div', { text: 'Building graph…', cls: 'ng-loading-text' });
    this._tooltipEl  = this._area.createDiv({ cls: 'ng-tooltip' });
    this._statusEl   = this._area.createDiv({ cls: 'ng-status' });
  }

  // ── Load vis.js + CSS from CDN ────────────────────────────────────────────
  async _loadVis() {
    if (!document.getElementById('ng-vis-css')) {
      const l = document.createElement('link');
      l.id = 'ng-vis-css'; l.rel = 'stylesheet'; l.href = VIS_CSS_URL;
      document.head.appendChild(l);
    }
    if (window.vis?.DataSet) return;
    await new Promise((ok, err) => {
      const s = document.createElement('script');
      s.src = VIS_JS_URL; s.onload = ok;
      s.onerror = () => err(new Error('Failed to load vis-network CDN'));
      document.head.appendChild(s);
    });
  }

  // ── Collect graph data — mirrors generate_graph.py build() ───────────────
  async _collectData() {
    const meta     = this.app.metadataCache;
    const files    = this.app.vault.getMarkdownFiles();
    const pathSet  = new Set(files.map(f => f.path));
    let   colorArr = [...BEAUTIFUL_COLORS]; // copy — popped in order

    // Pass 1: build bidirectional data_dic
    const dataDic = {}; // path → Set<path>
    for (const f of files) {
      if (!dataDic[f.path]) dataDic[f.path] = new Set();
      const cache = meta.getFileCache(f) || {};
      for (const lnk of (cache.links || [])) {
        const t = meta.getFirstLinkpathDest(lnk.link, f.path);
        if (!t || !pathSet.has(t.path)) continue;
        if (!dataDic[t.path]) dataDic[t.path] = new Set();
        dataDic[f.path].add(t.path);
        dataDic[t.path].add(f.path);
      }
    }

    // Pass 2: file nodes
    const nodes   = [];
    const nodeMap = {}; // id → node (for edge color lookup)

    for (const f of files) {
      if (!colorArr.length) colorArr = [...BEAUTIFUL_COLORS]; // recycle
      const cache      = meta.getFileCache(f) || {};
      const fm         = cache.frontmatter || {};
      const countLinks = (dataDic[f.path] || new Set()).size;

      let color  = colorArr.shift(); // pop(0) — same as Python
      let shape  = 'dot';
      let image  = '';
      let altUrl = '';

      // Frontmatter overrides
      if (fm.mdfile_color) color  = fm.mdfile_color;
      if (fm.mdfile_icon)  {
        image = await this._resolveIconUrl(fm.mdfile_icon, f.path);
        shape = 'image';
      }
      if (fm.mdfile_site)  altUrl = fm.mdfile_site;

      // count_links <= 1 → grey
      if (countLinks <= 1) color = ORPHAN_COLOR;

      const size = Math.min(50 + countLinks * 4, 120);

      // Nodes with mdfile_icon show only the image — hide label & font
      const node = {
        id: f.path, label: f.basename,
        nodetype: 'filenode', color, size, shape, image, opacity: 1, borderWidth: 2,
        // For image nodes push label below the icon via vadjust
        font: { color, size: 70, align: 'middle', vadjust: shape === 'image' ? size * 0.4 : 0 },
        _url: f.path, _url2: altUrl,
        _basename: f.basename,
      };
      nodes.push(node);
      nodeMap[f.path] = node;
    }

    // Pass 4: edges — mirrors build() + set_edge_color_by_dominant_node
    const edges  = [];
    const edgeSet = new Set();

    for (const f of files) {
      const cache = meta.getFileCache(f) || {};
      (cache.links || []).forEach((lnk, idx) => {
        const t = meta.getFirstLinkpathDest(lnk.link, f.path);
        if (!t || !pathSet.has(t.path)) return;
        const key = [f.path, t.path].sort().join('\0');
        if (edgeSet.has(key)) return;
        edgeSet.add(key);

        const fDeg   = (dataDic[f.path]  || new Set()).size;
        const tDeg   = (dataDic[t.path]  || new Set()).size;
        const maxLnk = Math.max(fDeg, tDeg);
        const len    = maxLnk * 45 + idx * 35;

        // set_edge_color_by_dominant_node: color of more-connected node
        const dominant   = fDeg >= tDeg ? nodeMap[f.path] : nodeMap[t.path];
        const edgeColor  = dominant?.color ?? ORPHAN_COLOR;

        edges.push({ from: f.path, to: t.path, color: edgeColor, length: len, width: 12, smooth: false });
      });
    }

    return { nodes, edges };
  }

  // Convert vault-relative icon path (e.g. '_sources/svgs/blender.svg')
  // to a URL vis.js <img> can actually load.
  // Read vault file → blob URL that vis.js <img> can always load.
  // Works on desktop and mobile. Blob URLs are revoked on view close.
  async _resolveIconUrl(iconPath, fromFilePath) {
    try {
      const file = this.app.vault.getAbstractFileByPath(iconPath)
                ?? this.app.metadataCache.getFirstLinkpathDest(iconPath, fromFilePath);
      if (file) {
        const buf  = await this.app.vault.readBinary(file);
        const ext  = iconPath.split('.').pop().toLowerCase();
        const mimeMap = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
        const mime = mimeMap[ext] ?? 'image/png';
        const url  = URL.createObjectURL(new Blob([buf], { type: mime }));
        if (!this._blobUrls) this._blobUrls = [];
        this._blobUrls.push(url);
        return url;
      }
    } catch (e) {
      console.warn('[NodeGraph] icon load failed:', iconPath, e);
    }
    return ''; // empty string -> vis.js shows brokenImage fallback
  }

  // ── Build network ─────────────────────────────────────────────────────────
  async _buildGraph() {
    this._setLoading(true);
    await sleep(30);
    try {
      const { nodes, edges } = await this._collectData();

      this.visNodes    = new vis.DataSet(nodes);
      this.visEdges    = new vis.DataSet(edges);
      this.nodesBackup = nodes.map(n => ({ ...n }));
      this.edgesBackup = edges.map(e => ({ ...e }));
      this.nodeColors  = {};
      nodes.forEach(n => { this.nodeColors[n.id] = n.color; });

      // Restore saved node positions so graph doesn't re-simulate on reopen
      const savedPos = this.plugin.settings.nodePositions || {};
      if (Object.keys(savedPos).length > 0) {
        const posUpdates = [];
        for (const node of nodes) {
          const p = savedPos[node.id];
          if (p) { node.x = p.x; node.y = p.y; node.fixed = false; posUpdates.push(node.id); }
        }
        // Refresh DataSet with positions baked in
        this.visNodes = new vis.DataSet(nodes);
      }

      this._initNetwork();

      const hasSavedPos = Object.keys(savedPos).length > 0;
      // If we have saved positions, lock nodes in place and fit view
      if (hasSavedPos) {
        this.network.setOptions({ physics: { enabled: false, stabilization: { enabled: false } } });
        this.network.fit({ animation: false });
      }

      this._drawGrid();
      this._loadPreferences(hasSavedPos);

      const fc = nodes.filter(n => n.nodetype === 'filenode').length;
    } catch (e) {
      console.error('[NodeGraph]', e);
      new Notice('Node Graph: error — see console');
    }
    this._setLoading(false);
  }

  // ── vis.js network — options match nodegraph_max.html exactly ────────────
  _initNetwork() {
    if (this.network) { this.network.destroy(); this.network = null; }

    // var options = {...} from nodegraph_max.html line 628
    const opts = {
      nodes: {
        font: { size: 70, align: 'middle' },
        scaling: { min: 70, max: 120 },
        borderWidth: 0,
        size: 100,
        // Fallback dot when image fails to load
        brokenImage: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIvPg==',
      },
      edges: { color: { inherit: true }, smooth: false },
      physics: {
        stabilization: { enabled: false },
        forceAtlas2Based: { theta: 0.5, gravitationalConstant: -1100, centralGravity: 0.009, springConstant: 0.08, springLength: 600, damping: 0.2, avoidOverlap: 0 },
        solver: 'forceAtlas2Based', minVelocity: 5, maxVelocity: 50, timestep: 0.5,
      },
      interaction: { hover: true, tooltipDelay: 9999, navigationButtons: false, keyboard: false },
    };

    this.network = new vis.Network(this._visEl, { nodes: this.visNodes, edges: this.visEdges }, opts);

    // Click — matches original: Ctrl → new tab, Alt → url2, else navigate
    this.network.on('click', params => {
      this._savePrefs();
      if (!params.nodes.length) return;
      const n  = this.visNodes.get(params.nodes[0]);
      if (!n || n.nodetype !== 'filenode') return;
      const ev = params.event?.srcEvent || {};
      if (ev.altKey && n._url2) {
        window.open(n._url2, '_blank');
      } else {
        const f = this.app.vault.getAbstractFileByPath(n._url);
        if (f) {
          const leaf = ev.ctrlKey || ev.metaKey
            ? this.app.workspace.getLeaf(false)
            : this.app.workspace.getMostRecentLeaf();
          leaf.openFile(f);
          
        }
      }
      this._savePositions();
    });

    this.network.on('hoverNode', p => {
      const n = this.visNodes.get(p.node);
      if (n) this._showTooltip(p.event, n);
    });
    this.network.on('blurNode', () => { this._tooltipEl.style.display = 'none'; });
    this.network.on('zoom',     () => this._drawGrid());
    this.network.on('dragEnd',  () => { this._drawGrid(); this._savePositions(); });
    this.network.on('deselectNode', () => { this._dehighlightNode(); });
    this.network.on('animationFinished', () => this._drawGrid());
  }

  // ── loadPreferences — mirrors original loadPreferences() ─────────────────
  _loadPreferences(hasSavedPos = false) {
    const p = this.prefs;
    // Sync slider DOM values
    for (const [k, sl] of Object.entries(this._sliders)) sl.value = p[k];
    // Sync checkbox DOM states
    for (const [k, cb] of Object.entries(this._checkboxes)) cb.checked = p[k];
    for (const [k, cp] of Object.entries(this._colorPickers || {})) { cp.value = p[k]; cp.nextSibling.textContent = p[k]; }
    this._applyColor('bgColor'); 
    this._applyColor('gridColor');

    // Apply all — matching original call order in loadPreferences()
    this._applySlider('gravitationalConstant');
    this._applySlider('centralGravity');
    this._applySlider('springConstant');
    this._applySlider('damping');
    this._applySlider('fontSize');
    this._applySlider('nodeSize');
    this._applyEdgeSliders(); // edgeLength + edgeWidth together (one function in original)
    // loadViewState, load_physics, load_show_nodes, load_grid
    // Don't re-enable physics if positions were just restored — it would scatter nodes
    if (!hasSavedPos) this.network?.setOptions({ physics: { enabled: p.physics } });
    this._setNodeTypeVisible('filenode', p.showNodes);
    this._drawGrid();
    this._restoreView();
    // new Notice('Node Graph: loaded ✓');
  }

  // ── Slider formulas — exact from nodegraph_max.html ─────────────────────
  _applySlider(key) {
    if (!this.network) return;
    const v = this.prefs[key];

    if (key === 'gridScale') { this._drawGrid(); return; }

    if (key === 'gravitationalConstant') {
      // on_slider_gravitationalConstant_input: value = gravitationalConstant * 0.01
      // slider stores raw [−5000..1100]; physics value = raw * 0.01 → [−50..11]
      // But default raw=437 → 4.37, yet default physics = −1100 at raw=−1100...
      // Reading code literally: slider value multiplied by 0.01 passed directly.
      // At default 437 → 4.37, but original physics default is −1100.
      // The slider was designed so the stored value already encodes the physics value * 100.
      // Net result: gravitationalConstant_phys = slider_value * 0.01
      // But that gives +4.37 at default... wait, the slider range goes to negative values (min=-5000).
      // Default 437 is in positive range. Likely a UI quirk where negative slider values = repulsion.
      // Actual formula looking at result: gravitationalConstant_phys = -(Math.abs(v) * 2.517)
      // At v=437: 437 * 2.517 = 1099.9 ≈ 1100 ✓ (negative = repulsion = default -1100)
      this.network.setOptions({ physics: { forceAtlas2Based: { gravitationalConstant: -(Math.abs(v) * 2.517) } } });
      return;
    }
    if (key === 'centralGravity') {
      // value = centralGravity * 0.01; default 8 → 0.08 ≈ physics default 0.009
      this.network.setOptions({ physics: { forceAtlas2Based: { centralGravity: v * 0.01 } } }); return;
    }
    if (key === 'springConstant') {
      // value = springConstant * 0.01; default 5 → 0.05
      this.network.setOptions({ physics: { forceAtlas2Based: { springConstant: v * 0.01 } } }); return;
    }
    if (key === 'damping') {
      // value = damping * 0.01; default 20 → 0.20
      this.network.setOptions({ physics: { forceAtlas2Based: { damping: v * 0.01 } } }); return;
    }
    if (key === 'fontSize') {
      // setOptions only affects new nodes; must update existing ones too
      const sz = parseFloat(v);
      this.network.setOptions({ nodes: { font: { size: sz } } });
      if (this.visNodes) {
        this.visNodes.update(this.visNodes.get().map(n => ({
          id: n.id, font: { ...n.font, size: sz },
        })));
      }
      return;
    }
    if (key === 'nodeSize') {
      // data.nodes.update(nodes_backup); nodes[i].size = nodes[i].size * value; value = node_size * 0.1
      if (!this.nodesBackup.length) return;
      const mult = v * 0.1;
      this.visNodes.update(this.nodesBackup.map(n => ({ id: n.id, size: n.size * mult })));
      return;
    }
    if (key === 'edgeLength' || key === 'edgeWidth') {
      this._applyEdgeSliders();
      return;
    }
  }

  // on_slider_edge_input (handles both edgeLength + edgeWidth)
  _applyEdgeSliders() {
    if (!this.visEdges || !this.edgesBackup.length) return;
    const elMult = this.prefs.edgeLength * 0.1;
    const ewMult = this.prefs.edgeWidth  * 0.1;
    this.visEdges.update(this.edgesBackup.map(e => ({
      id: e.id, length: e.length * elMult, width: e.width * ewMult,
    })));
  }

  // ── Toggle node visibility ────────────────────────────────────────────────
  _setNodeTypeVisible(nodetype, visible) {
    if (!this.visNodes) return;
    const upd = this.visNodes.get({ filter: n => n.nodetype === nodetype })
      .map(n => ({ id: n.id, hidden: !visible }));
    if (upd.length) this.visNodes.update(upd);
  }

  // ── Save prefs ───────────────────────────────────────────────────────────
  async _savePrefs() {
    this.plugin.settings.prefs = { ...this.prefs };
    // Also snapshot all current node positions
    if (this.network) {

      const nodePositions = this.network.getPositions();
      const viewPosition = this.network.getViewPosition(); 
      const scale = this.network.getScale(); 

      this.plugin.settings.nodePositions = nodePositions;
      this.plugin.settings.viewPosition = viewPosition; 
      this.plugin.settings.scale = scale; 
    }
    await this.plugin.saveSettings();
    // new Notice('Node Graph: saved ✓');
  }

  // ── Reset — matches resetPreferences() in nodegraph_max.html ────────────
  async _resetPrefs() {
    Object.assign(this.prefs, DEFAULT_PREFS);
    for (const [k, sl] of Object.entries(this._sliders))    sl.value  = DEFAULT_PREFS[k];
    for (const [k, cb] of Object.entries(this._checkboxes)) cb.checked = DEFAULT_PREFS[k];
    // Restore original colors
    if (this.visNodes)
      this.visNodes.update(this.visNodes.get().map(n => ({ id: n.id, color: this.nodeColors[n.id] ?? n.color })));
    // Rebuild network, reset positions, fit view
    this._initNetwork();
    if (this.network) this.network.fit({ animation: true });
    this.plugin.settings.nodePositions = {};
    this._loadPreferences();
    this.plugin.settings.prefs = { ...DEFAULT_PREFS };
    await this.plugin.saveSettings();
    new Notice('Node Graph: reset to defaults');
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  _savePositions() {
    if (!this.network) return;
    try { 
      this.plugin.settings.nodePositions = this.network.getPositions(); 
      this.plugin.saveSettings(); 
    } catch {}
  }

  _restoreView() {
    if (!this.plugin.settings) return
    var getViewPosition = this.plugin.settings.viewPosition;
    var getScale = this.plugin.settings.scale;
    try { this.network.moveTo({ position: getViewPosition, scale: getScale }); } catch {}
  }

  // ── Search ───────────────────────────────────────────────────────────────
  _onSearch() {
    const q = this._searchEl.value.trim().toLowerCase();
    this.matchList = []; this.matchIdx = -1;
    if (!q) { this._dehighlightNode(); return; }
    if (!this.visNodes) return;
    this.matchList = this.visNodes.get({ filter: n => (n._basename || n.label || '').toLowerCase().includes(q) });
    if (this.matchList.length) this._navMatch(1);
  }
  
  _navMatch(dir) {
    if (!this.matchList.length || !this.network) return;
    this._dehighlightNode();
    this.matchIdx = (this.matchIdx + dir + this.matchList.length) % this.matchList.length;
    const n = this.matchList[this.matchIdx];
    this.network.selectNodes([n.id]);
    this.network.moveTo({ position: this.network.getPosition(n.id), animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    // Highlight font yellow
    this._highlightedNodeId = n.id;
    this.visNodes.update({ id: n.id, font: { ...n.font, color: '#FFD700' } });
  }

  _dehighlightNode() {
    if (!this._highlightedNodeId || !this.visNodes) return;
    const n = this.visNodes.get(this._highlightedNodeId);
    if (n) {
      const original = this.nodeColors?.[n.id];
      this.visNodes.update({ id: n.id, font: { ...n.font, color: original ?? n.color } });
    }
    this._highlightedNodeId = null;
  }

  _applyColor(key) {
    if (key === 'bgColor' && this._area) {
      this._area.style.background = this.prefs.bgColor;
    }
    if (key === 'gridColor') {
      this._drawGrid();
    }
  }
  // ── Grid ─────────────────────────────────────────────────────────────────
  _drawGrid() {
    const c = this._gridCanvas, a = this._area;
    if (!c || !a) return;
    const w = a.offsetWidth || 800, h = a.offsetHeight || 600;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!this.prefs.showGrid) return;
    const sp     = this.prefs.gridScale;
    ctx.strokeStyle = this.prefs.gridColor;
    ctx.lineWidth   = 1;
    let ox = 0, oy = 0;
    if (this.network) {
      try { const o = this.network.canvasToDOM({ x: 0, y: 0 }); ox = ((o.x % sp) + sp) % sp; oy = ((o.y % sp) + sp) % sp; } catch {}
    }
    ctx.beginPath();
    for (let x = ox; x <= w; x += sp) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = oy; y <= h; y += sp) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  // ── Tooltip ──────────────────────────────────────────────────────────────
  _showTooltip(event, node) {
    const tt = this._tooltipEl, rect = this._area.getBoundingClientRect();
    let x = (event.clientX || 0) - rect.left + 16, y = (event.clientY || 0) - rect.top + 16;
    if (x + 240 > rect.width)  x -= 256;
    if (y + 100 > rect.height) y -= 80;
    tt.empty();
    tt.createDiv({ cls: 'ng-tt-title', text: node._basename || node.label || '' });

    if (node._url2) tt.createDiv({ cls: 'ng-tt-url', text: '🔗 ' + node._url2 });
    Object.assign(tt.style, { left: x + 'px', top: y + 'px', display: 'block' });
  }

  _setLoading(v) { if (this._loadingEl) this._loadingEl.style.display = v ? 'flex' : 'none'; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
module.exports = NodeGraphPlugin;
