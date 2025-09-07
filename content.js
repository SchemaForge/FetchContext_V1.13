(() => {
  "use strict";

  // State
  const state = {
    isOpen: true,
    isFullscreen: false,
    isCollapsed: true,
    isAuthenticated: false,
    isFirstRun: false,
    currentView: "fetch", // fetch | history | settings
    apiKey: "",
    error: null,
    loading: false,
    // prompt
    originalPrompt: "",
    enhancedPrompt: "",
    currentPrompt: null,
    // schemas
    schemas: [],
    selectedSchemas: [],
    contextSearchTerm: "",
    // history
    promptHistory: [],
    historyLoading: false,
    historySearch: "",
    // Q&A
    questions: [],
    submittedAnswers: [],
    submittingAnswers: false,
    // file contexts
    fileContexts: [],
    selectedFileExtracts: [],
    showContextSelection: false,
    showQuestions: false,
    showFileContext: false,
    copiedPrompt: false,
    // polling state
    isPollingQuestions: false,
    questionsPollAttempts: 0
  };

  const STORAGE_KEYS = {
    apiKey: "contextos_preview_api_key",
    hasRun: "contextos_preview_has_run"
  };

  // Utils
  const el = (tag, opts = {}) => Object.assign(document.createElement(tag), opts);

  const formatDate = (dateString) => new Date(dateString).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });

  const getStatusColor = (status) => {
    switch (status) {
      case "completed": return "status-completed";
      case "failed": return "status-failed";
      case "processing": return "status-processing";
      case "pending": return "status-pending";
      default: return "status-default";
    }
  };

  const getContextTypeColor = (type) => {
    switch (type) {
      case "business": return "badge-blue";
      case "role-specific": return "badge-green";
      case "project-specific": return "badge-purple";
      default: return "badge-gray";
    }
  };

  const generateAdditionalContext = () => {
    if (!state.selectedSchemas.length) return "";
    const selected = state.schemas.filter(s => state.selectedSchemas.includes(s.id));
    if (!selected.length) return "";
    const parts = [];
    selected.forEach(schema => {
      const p = [];
      p.push(`Business Name: ${schema.companyName}`);
      if (schema.targetAudience && schema.targetAudience.length) p.push(`Target Personas: ${schema.targetAudience.join(', ')}`);
      if (schema.type) p.push(`Context Type: ${schema.type}`);
      if (schema.keyGoals && schema.keyGoals.length) p.push(`Key Goals: ${schema.keyGoals.join(', ')}`);
      parts.push(p.join('; '));
    });
    return `\n\nADDITIONAL CONTEXT: ${parts.join(' | ')}`;
  };

  const generateQAContext = () => {
    if (!Array.isArray(state.submittedAnswers) || state.submittedAnswers.length === 0) return "";
    const qa = state.submittedAnswers
      .filter(qa => qa && typeof qa.answer === 'string' && qa.answer.trim() !== '')
      .map(qa => `Q: ${qa.question}\nA: ${qa.answer}`)
      .join('\n\n');
    return qa ? `\n\nQ&A CONTEXT:\n${qa}` : "";
  };

  const generateFileContext = () => {
    if (!state.selectedFileExtracts.length) return "";
    const extracts = state.selectedFileExtracts.join('\n\n');
    return extracts ? `\n\nSUPPLEMENTARY EXTRACTS:\n${extracts}` : "";
  };

  // API base helpers
  const API_BASE = "https://uycbruvaxgawpmdddqry.supabase.co";
  const apiUrl = (path) => {
    const p = String(path || "").replace(/^\/+/, "");
    return `${API_BASE}/${p}`;
  };

  // Logo helpers
  const getLogoUrl = () => {
    // Prefer extension-packaged asset if available
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
        return chrome.runtime.getURL('logo.png');
      }
    } catch (_) {}
    return '';
  };

  const renderLogo = (size = 16) => {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap w-5 h-5 text-blue-600" style="width:${size}px;height:${size}px;display:inline-block;vertical-align:middle;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
  };

  const saveLocal = () => {
    try {
      if (state.apiKey) localStorage.setItem(STORAGE_KEYS.apiKey, state.apiKey);
    } catch (_) {}
  };

  const loadLocal = () => {
    try {
      const savedKey = localStorage.getItem(STORAGE_KEYS.apiKey) || "";
      state.apiKey = savedKey;
      state.isAuthenticated = !!savedKey;
      const hasRun = localStorage.getItem(STORAGE_KEYS.hasRun) === "1";
      state.isFirstRun = !hasRun;
      try { localStorage.setItem(STORAGE_KEYS.hasRun, "1"); } catch (_) {}
    } catch (_) {}
  };

  // API functions
  const ensureConfigured = () => {
    const hasKey = !!(state.apiKey && state.apiKey.trim());
    const ok = hasKey;
    if (!ok) {
      state.isAuthenticated = false;
    }
    return ok;
  };

  const loadSchemas = async () => {
    if (!ensureConfigured()) return;
    state.loading = true; render();
    try {
      const res = await fetch(`${apiUrl('functions/v1/user-schemas-api')}?api_key=${encodeURIComponent(state.apiKey)}&source=chrome`, {
        method: "GET",
        headers: { "Accept": "application/json" },
        mode: "cors"
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load schemas");
      }
      const data = await res.json();
      state.schemas = (data.schemas || []).filter(s => s.isPublished);
      state.error = null;
    } catch (e) {
      state.error = e instanceof Error ? e.message : "Failed to load schemas";
      if (String(state.error).includes("Invalid")) {
        state.isAuthenticated = false;
        state.apiKey = "";
        try { localStorage.removeItem(STORAGE_KEYS.apiKey); } catch(_){}}
    } finally {
      state.loading = false; render();
    }
  };

  const submitPrompt = async () => {
    if (!state.originalPrompt.trim()) { state.error = "Please enter a prompt"; render(); return; }
    if (!ensureConfigured()) { render(); return; }
    if (!state.selectedSchemas.length) { state.error = "Please select at least one context"; render(); return; }

    state.loading = true; state.error = null; state.currentPrompt = { status: 'pending' };
    // Show placeholders for File Context and Questions while processing
    state.showFileContext = true;
    state.showQuestions = true;
    state.isPollingQuestions = true;
    state.questionsPollAttempts = 0;
    render();
    try {
      const payload = { prompt: state.originalPrompt.trim() };
      if (state.selectedSchemas.length) payload.schemaIds = state.selectedSchemas;

      const res = await fetch(`${apiUrl('functions/v1/submit-prompt')}?api_key=${encodeURIComponent(state.apiKey)}&source=chrome`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
        mode: "cors"
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to submit prompt");
      }
      const data = await res.json();
      // Ensure immediate status visibility with prompt id
      state.currentPrompt = { id: data.prompt_id, status: 'pending' }; render();
      pollPromptStatus(data.prompt_id);
    } catch (e) {
      state.error = e instanceof Error ? e.message : "Failed to submit prompt";
      state.currentPrompt = null;
      state.loading = false; render();
    }
  };

  const pollPromptStatus = async (promptId) => {
    const maxAttempts = 30;
    const questionsMaxAttempts = 30;
    let attempts = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${apiUrl(`functions/v1/retrieve-prompts/${promptId}`)}?api_key=${encodeURIComponent(state.apiKey)}&source=chrome`, {
          method: "GET",
          headers: { "Accept": "application/json" },
          mode: "cors"
        });
        if (!res.ok) throw new Error("Failed to retrieve prompt");
        const prompt = await res.json();
        state.currentPrompt = prompt;

        if (prompt.context && Array.isArray(prompt.context)) {
          state.fileContexts = prompt.context.map((ctx, index) => ({
            id: `${prompt.id}_${index}`,
            source: ctx.source,
            content: ctx.content,
            selected: false
          }));
          // Ensure the Questions box stays visible when File Context arrives
          state.showQuestions = true;
          if (!(Array.isArray(state.questions) && state.questions.length)) {
            state.isPollingQuestions = true;
          }
        } else {
          state.fileContexts = [];
        }

        // Update questions immediately when available (do not wait for completion)
        if (Array.isArray(prompt.questions_answers) && prompt.questions_answers.length) {
          state.questions = prompt.questions_answers;
          state.showQuestions = true;
          state.isPollingQuestions = false;
        }

        // Re-render to reflect any new File Contexts or Questions while still processing
        if (prompt.status !== "completed") {
          render();
        }

        if (prompt.status === "completed") {
          state.enhancedPrompt = prompt.enriched_prompt || "";
          if (Array.isArray(prompt.questions_answers) && prompt.questions_answers.length) {
            state.questions = prompt.questions_answers;
            state.showQuestions = true;
            state.isPollingQuestions = false;
          }
          // Continue polling briefly for questions even after completion if none yet
          const hasQuestions = Array.isArray(state.questions) && state.questions.length > 0;
          if (!hasQuestions) {
            if (state.questionsPollAttempts < questionsMaxAttempts) {
              state.isPollingQuestions = true;
              state.loading = false; render();
              state.questionsPollAttempts++;
              setTimeout(poll, 2000);
            } else {
              state.isPollingQuestions = false;
              state.loading = false; render();
            }
          } else {
            state.isPollingQuestions = false;
            state.loading = false; render();
          }
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(poll, 2000);
        } else {
          state.error = "Prompt processing timed out";
          state.isPollingQuestions = false; state.loading = false; render();
        }
      } catch (_) {
        state.error = "Failed to retrieve prompt";
        state.isPollingQuestions = false; state.loading = false; render();
      }
    };
    poll();
  };

  const submitAnswers = async () => {
    if (!state.currentPrompt || !state.currentPrompt.id) return;
    state.submittingAnswers = true; render();
    try {
      const res = await fetch(`${apiUrl(`functions/v1/respond-prompt/${state.currentPrompt.id}`)}?api_key=${encodeURIComponent(state.apiKey)}&source=chrome`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(state.questions || []),
        mode: "cors"
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to submit answers");
      }
      state.showQuestions = false;
      state.submittedAnswers = Array.isArray(state.questions) ? [...state.questions] : [];
      state.error = null;
      // Re-poll for updated enhanced prompt
      pollPromptStatus(state.currentPrompt.id);
    } catch (e) {
      state.error = e instanceof Error ? e.message : "Failed to submit answers";
    } finally {
      state.submittingAnswers = false; render();
    }
  };


  const loadPromptHistory = async () => {
    if (!ensureConfigured()) { render(); return; }
    state.historyLoading = true; render();
    try {
      let url = `${apiUrl('functions/v1/retrieve-prompts')}?status=completed&api_key=${encodeURIComponent(state.apiKey)}`;
      if (state.historySearch && state.historySearch.trim()) url += `&search=${encodeURIComponent(state.historySearch.trim())}`;
      url += `&source=chrome`;
      const res = await fetch(url, { method: "GET", headers: { "Accept": "application/json" }, mode: "cors" });
      if (!res.ok) throw new Error("Failed to load history");
      const data = await res.json();
      // Expecting an array of prompts
      state.promptHistory = Array.isArray(data) ? data : (Array.isArray(data.prompts) ? data.prompts : []);
    } catch (_) {
      state.promptHistory = [];
    } finally {
      state.historyLoading = false; render();
    }
  };

  // Clipboard
  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      state.copiedPrompt = true; render();
      setTimeout(() => { state.copiedPrompt = false; render(); }, 2000);
    } catch (_) {
      state.error = "Failed to copy to clipboard"; render();
    }
  };

  // UI rendering
  let root, shadow, container;
  let globalEnterHandlerBound = false;

  const ensureRoot = () => {
    if (document.getElementById("contextos-preview-root")) return;
    root = el("div", { id: "contextos-preview-root" });
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({ mode: "open" });
    container = el("div");
    shadow.appendChild(styleEl());
    shadow.appendChild(container);
    // Inject transitions for page reflow and scaling when sidebar expands/collapses/fullscreens
    if (!document.getElementById("contextos-page-adjust-style")) {
      const headStyle = document.createElement("style");
      headStyle.id = "contextos-page-adjust-style";
      headStyle.textContent = "html{transition:margin-right 150ms ease} body{transition:transform 150ms ease;transform-origin:left top}";
      (document.head || document.documentElement).appendChild(headStyle);
    }
    // Recompute offsets on viewport resize
    try { window.addEventListener('resize', () => { try { updatePageOffset(); } catch(_) {} }); } catch(_) {}
  };

  // (Removed) In-page fullscreen control was removed

  const styleEl = () => {
    const s = el("style");
    s.textContent = `
      :host, * { box-sizing: border-box; }
      .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 480px; background: #fff; border-left: 1px solid #e5e7eb; box-shadow: -2px 0 10px rgba(0,0,0,0.08); display: flex; z-index: 2147483647; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
      .panel.full { width: 60vw; border-left: none; }
      .panel.collapsed { width: 48px; }
      .panel.collapsed .main { display: none; }
      .ribbon { width: 48px; background: #f9fafb; border-right: 1px solid #e5e7eb; display: flex; flex-direction: column; padding: 8px; }
      .ribbon button { width: 32px; height: 32px; border-radius: 8px; border: none; background: transparent; color: #4b5563; cursor: pointer; margin-bottom: 6px; }
      .ribbon button.active { background: #2563eb; color: #fff; }
      .ribbon #ctx-nav-history:not(.active) { background: #fff; }
      .ribbon #ctx-nav-fetch:not(.active):hover, .ribbon #ctx-nav-history:not(.active):hover, .ribbon #ctx-nav-settings:not(.active):hover, .ribbon #ctx-nav-website:hover { background: #e5e7eb; }
      .main { flex: 1; display: flex; flex-direction: column; }
      .header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
      .header .title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: #111827; font-size: 15px; }
      .header .actions { display: flex; align-items: center; gap: 8px; }
      .header-btn { border: none; background: transparent; color: #9ca3af; cursor: pointer; padding: 4px; }
      .header-btn:hover { color: #4b5563; }
      .content { flex: 1; overflow: auto; }
      .section { padding: 12px; }
      .textarea { width: 100%; border: none; outline: none; resize: none; font-size: 13px; color: #111827; }
      .box { border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
      .box-header { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; background: #f9fafb; border-radius: 8px 8px 0 0; }
      .box-body { padding: 12px; }
      .row { display: flex; align-items: center; gap: 8px; }
      .history-item { cursor: pointer; transition: background-color 150ms ease; background: #fff; }
      .history-item:hover { background: #e5e7eb; }
      .grow { flex: 1; }
      .btn { display: inline-flex; align-items: center; justify-content: center; border: none; cursor: pointer; border-radius: 999px; font-weight: 600; font-size: 12px; transition: background-color 150ms ease, color 150ms ease; }
      .btn-send { width: 24px; height: 24px; color: #fff; background: #111827; }
      .btn-send:hover { background: #1f2937; }
      .btn-send:disabled { background: #9ca3af; cursor: not-allowed; }
      .btn-send:disabled:hover { background: #9ca3af; }
      .btn-pill { padding: 4px 8px; background: #f3f4f6; color: #374151; border-radius: 8px; cursor: pointer; }
      #ctx-toggle-context.btn-pill { border-radius: 999px; background: #ffffff; border: 1px solid #e5e7eb; font-size: 16px; }
      #ctx-toggle-context.btn-pill:hover { background: #f9fafb; }
      .btn-primary { padding: 6px 10px; background: #2563eb; color: #fff; border-radius: 8px; }
      .btn-primary:hover { background: #1d4ed8; }
      .btn-outline { padding: 6px 10px; background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; }
      .btn-outline:hover { background: #f3f4f6; }
      .btn-new { padding: 6px 10px; background: #f3f4f6; color: #374151; border-radius: 8px; font-weight: 500; }
      .btn-new:hover { background: #e5e7eb; }
      .btn-new:active { background: #d1d5db; }
      .tag { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; font-size: 11px; border: 1px solid #e5e7eb; }
      .badge-blue { background: #dbeafe; color: #1e3a8a; border-color: #bfdbfe; }
      .badge-green { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
      .badge-purple { background: #ede9fe; color: #5b21b6; border-color: #ddd6fe; }
      .badge-gray { background: #f3f4f6; color: #374151; border-color: #e5e7eb; }
      .status { display: inline-flex; padding: 2px 6px; border-radius: 999px; font-size: 11px; font-weight: 600; }
      .status-completed { color: #16a34a; background: #dcfce7; }
      .status-failed { color: #dc2626; background: #fee2e2; }
      .status-processing { color: #2563eb; background: #dbeafe; }
      .status-pending { color: #ca8a04; background: #fef3c7; }
      .status-default { color: #4b5563; background: #e5e7eb; }
      .muted { color: #6b7280; font-size: 12px; }
      .muted-sm { color: #6b7280; font-size: 11px; }
      .input { width: 100%; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 12px; }
      .input:focus { outline: 2px solid #93c5fd; border-color: transparent; }
      .switch-row { display: flex; align-items: center; justify-content: space-between; }
      .divider { height: 1px; background: #e5e7eb; margin: 8px 0; }
      .code { white-space: pre-wrap; font-size: 12px; color: #111827; }
      .pill { padding: 2px 6px; background: #f3f4f6; border-radius: 999px; font-size: 11px; }
      /* Schema pill styles (matches Image 1) */
      .schema-pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:600; color:#1d4ed8; background:#dbeafe; border:1px solid #bfdbfe; }
      .schema-pill + .schema-pill { margin-left:6px; }
      .schema-pill-remove { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border:none; border-radius:999px; background:transparent; color:#1d4ed8; cursor:pointer; padding:0; }
      .schema-pill-remove:hover { background: rgba(29,78,216,0.12); }
      .schema-pill-remove svg { width:10px; height:10px; }
      .loading { animation: spin 1s linear infinite; display: inline-block; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .hidden { display: none; }
      .reopen-btn { position: fixed; right: 20px; bottom: 20px; width: 48px; height: 48px; border-radius: 999px; border: none; background: #2563eb; color: #fff; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; font-size: 18px; z-index: 2147483647; }
      .reopen-btn:hover { background: #1d4ed8; }
      #ctx-copy:hover { cursor: pointer; }
    `;
    return s;
  };

  const icon = (name) => {
    // Minimal inline SVG icons by name
    const map = {
      x: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M18.3 5.71L12 12.01l-6.3-6.3-1.4 1.41 6.3 6.3-6.3 6.3 1.4 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg>',
      settings: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings w-5 h-5 text-blue-600" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
      history: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-history w-5 h-5 text-blue-600" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg>',
      zap: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
      send: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-send w-3 h-3"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>',
      sendDisabled: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-send w-3 h-3"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>',
      copy: '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
      check: '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
      refresh: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw" style="width:14px;height:14px;display:inline-block;vertical-align:middle;color:#2563eb;"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>',
      eye: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye" style="width:14px;height:14px;display:inline-block;vertical-align:middle;"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
      eyeOff: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye-off" style="width:14px;height:14px;display:inline-block;vertical-align:middle;"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C5.5 20 2 12 2 12a21.87 21.87 0 0 1 5.06-7.94"></path><path d="M1 1l22 22"></path><path d="M9.88 9.88A3 3 0 0 0 12 15a3 3 0 0 0 2.12-.88"></path><path d="M14.12 14.12L9.88 9.88"></path><path d="M21.82 12.82A21.87 21.87 0 0 0 22 12s-3.5-7-10-7a10.94 10.94 0 0 0-3.12.46"></path></svg>',
      brain: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain w-4 h-4" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"></path><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"></path><path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path><path d="M19.938 10.5a4 4 0 0 1 .585.396"></path><path d="M6 18a4 4 0 0 1-1.967-.516"></path><path d="M19.967 17.484A4 4 0 0 1 18 18"></path></svg>'
    };
    return map[name] || "";
  };

  // Render helpers
  const renderHeaderTitle = () => {
    if (state.currentView === "fetch") return "Fetch Context";
    if (state.currentView === "history") return "Context History";
    return "Settings";
  };

  const renderStatusBar = () => {
    if (!state.currentPrompt) return "";
    if (!(state.currentPrompt.status === "pending" || state.currentPrompt.status === "processing")) return "";
    return `
      <div class="box" style="margin:8px 12px 0 12px;">
        <div class="box-body row">
          <span class="loading" style="width:16px;height:16px;border:2px solid #9ca3af;border-top-color:transparent;border-radius:50%;"></span>
          <div class="grow">
            <div style="font-size:13px;color:#374151;font-weight:600;">
              ${state.currentPrompt.status === 'pending' ? 'Processing your prompt...' : 'Enhancing with context...'}
            </div>
            <div class="muted-sm">This may take a few moments</div>
          </div>
          <div class="status ${getStatusColor(state.currentPrompt.status)}">${state.currentPrompt.status}</div>
        </div>
      </div>`;
  };

  const renderFetchView = () => {
    if (!state.isAuthenticated) {
      return `
        <div class="section">
          <div style="text-align:center;padding:24px 0;">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-key w-12 h-12 text-gray-400 mx-auto mb-4"><circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6"></path><path d="m15.5 7.5 3 3L22 7l-3-3"></path></svg>
            <div class="muted" style="margin-top:4px;">Enter your Fetch Context API key</div>
          </div>
          <div style="margin-top:12px;">
            <label class="muted" style="display:block;margin-bottom:6px;color:#111827;">API Key</label>
            <div class="row" style="gap:6px;">
              <input id="ctx-api-key" class="input grow" type="password" placeholder="Enter your API key" />
              <button id="ctx-api-key-toggle" class="btn btn-outline" title="Show/Hide">Show</button>
            </div>
          </div>

          ${state.error ? `<div class="box" style="background:#fef2f2;border-color:#fecaca;margin-top:12px;"><div class="box-body" style="color:#991b1b;font-size:12px;">${state.error}</div></div>`: ""}
          <button id="ctx-connect" class="btn btn-primary" style="width:100%;margin-top:12px;">Connect</button>
          ${state.isFirstRun && !state.apiKey ? `
          <div class="divider" style="margin-top:16px;"></div>
          <div class="box" style="margin-top:12px;">
            <div class="box-header" style="font-weight:600;color:#111827;font-size:13px;">Get Registered</div>
            <div class="box-body">
              <div class="muted-sm" style="margin-bottom:8px;">Don't have an API key - Visit FetchContext.ai</div>
              <button id="ctx-register" class="btn btn-primary" style="width:100%;background:#16a34a;">Register</button>
            </div>
          </div>
          ` : ''}
        </div>`;
    }

    const selectedSchemas = state.schemas.filter(s => state.selectedSchemas.includes(s.id));
    const filteredSchemas = state.schemas.filter(s => {
      const q = state.contextSearchTerm.toLowerCase();
      return s.name.toLowerCase().includes(q) || s.companyName.toLowerCase().includes(q) || s.type.toLowerCase().includes(q);
    });

    return `
      <div class="section">
        <div class="box">
          <div class="box-body">
            <textarea id="ctx-original-prompt" class="textarea" rows="3" placeholder="Write a prompt to get started">${escapeHtml(state.originalPrompt)}</textarea>
          </div>
          <div class="box-body" style="border-top:1px solid #f3f4f6;background:#f9fafb;border-radius:0 0 8px 8px;">
            <div class="row">
              <button id="ctx-toggle-context" class="btn-pill" title="Add context">+</button>
              <div class="grow" id="ctx-selected-tags">
                ${selectedSchemas.map(s => `<span class="schema-pill"><span>${escapeHtml(s.name)}</span><button data-remove-schema="${s.id}" class="schema-pill-remove" aria-label="Remove schema"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></span>`).join(' ')}
              </div>
              <button id="ctx-submit" class="btn btn-send" ${state.loading || !state.originalPrompt.trim() || !state.selectedSchemas.length ? 'disabled' : ''} title="Send">${state.loading || !state.originalPrompt.trim() || !state.selectedSchemas.length ? icon('sendDisabled') : icon('send')}</button>
            </div>
          </div>
        </div>

        ${state.showContextSelection ? `
          <div class="box" style="margin-top:12px;">
            <div class="box-header row" style="justify-content:space-between;">
              <div style="font-weight:600;color:#111827;font-size:13px;">Select Contexts</div>
              <button id="ctx-close-context" class="header-btn" title="Close">${icon('x')}</button>
            </div>
            <div class="box-body" style="border-bottom:1px solid #e5e7eb;">
              <input id="ctx-context-search" class="input" placeholder="Search contexts..." value="${escapeAttr(state.contextSearchTerm)}" />
            </div>
            <div class="box-body" style="max-height:192px;overflow:auto;padding:0;">
              ${state.loading && state.schemas.length === 0 ? `<div class="muted" style="text-align:center;">Loading contexts...</div>` :
                (filteredSchemas.length === 0 ? `<div class="muted" style="text-align:center;">${state.contextSearchTerm ? 'No contexts match your search' : 'No contexts available'}</div>` :
                  filteredSchemas.map(s => `
                    <button class="row" data-add-schema="${s.id}" style="width:100%;text-align:left;padding:12px 12px;border:none;outline:none;border-bottom:1px solid #e5e7eb;background:#fff;">
                      <div class="grow">
                        <div class="row" style="gap:8px;">
                          <div style="font-weight:600;color:#111827;font-size:13px;">${escapeHtml(s.name)}</div>
                          <span class="tag ${getContextTypeColor(s.type)}" style="padding:2px 6px;">${escapeHtml(s.type)}</span>
                        </div>
                        <div class="muted-sm">${escapeHtml(s.companyName)}</div>
                        <div class="muted-sm" style="margin-top:2px;">${escapeHtml(s.description || '')}</div>
                      </div>
                      ${state.selectedSchemas.includes(s.id) ? `<span class="status status-completed">Selected</span>` : ''}
                    </button>`).join('')
                )}
            </div>
          </div>` : ''}

        ${(state.fileContexts.length || (state.currentPrompt && (state.currentPrompt.status === 'pending' || state.currentPrompt.status === 'processing'))) ? `
          <div class="box" style="margin-top:12px;border-color:#bfdbfe;">
            <button id="ctx-filectx-toggle" class="box-body row" style="width:100%;justify-content:space-between;background:#eff6ff;border:none;outline:none;">
              <div class="row" style="gap:6px;">
                <span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text" style="width:16px;height:16px;display:inline-block;vertical-align:middle;color:#1d4ed8;"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path></svg></span>
                <span class="muted" style="color:#1d4ed8;">File Context (${state.fileContexts.filter(c=>c.selected).length}/${state.fileContexts.length} selected)</span>
              </div>
              <span>${state.showFileContext ? '▴' : '▾'}</span>
            </button>
            ${state.showFileContext ? `
              <div id="ctx-filectx-list" class="box-body" style="max-height:256px;overflow:auto;padding-top:6px;">
                ${state.fileContexts.length ? state.fileContexts.map(ctx => `
                  <div class="box" data-filectx="${ctx.id}" style="padding:8px;margin-bottom:8px;border-color:${ctx.selected ? '#93c5fd' : '#e5e7eb'};background:${ctx.selected ? '#eff6ff' : '#fff'};cursor:pointer;">
                    <div class="row" style="justify-content:space-between;margin-bottom:4px;">
                      <span class="muted" style="color:#1d4ed8;">${escapeHtml(ctx.source)}</span>
                      ${ctx.selected ? `<span class="status status-processing">${icon('check')} Selected</span>` : ''}
                    </div>
                    <div class="code">${escapeHtml(ctx.content)}</div>
                  </div>`).join('') : `
                  <div class="row" style="gap:8px;padding:8px;">
                    <span class="loading" style="width:16px;height:16px;border:2px solid #9ca3af;border-top-color:transparent;border-radius:50%;"></span>
                    <div class="grow">
                      <div style="font-size:13px;color:#374151;font-weight:600;">Retrieving file context...</div>
                      <div class="muted-sm">This may take a few moments</div>
                    </div>
                    ${state.currentPrompt ? `<div class="status ${getStatusColor(state.currentPrompt.status)}">${state.currentPrompt.status}</div>` : ''}
                  </div>
                `}
                ${state.fileContexts.filter(c=>c.selected).length ? `<div class="muted" style="padding-top:4px;border-top:1px solid #e5e7eb;">${state.fileContexts.filter(c=>c.selected).length} extract(s) will be added to your enhanced prompt</div>` : ''}
              </div>` : ''}
          </div>` : ''}


        ${state.currentPrompt ? `
          <div class="box" style="margin-top:12px;border-color:#fed7aa;">
            <button id="ctx-qa-toggle" class="box-body row" style="width:100%;justify-content:space-between;background:#fffbeb;border:none;outline:none;">
              <div class="row" style="gap:6px;">
                <span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-square" style="width:16px;height:16px;display:inline-block;vertical-align:middle;color:#9a3412;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>
                <span class="muted" style="color:#9a3412;">${state.submittedAnswers && state.submittedAnswers.length ? 'Update Answers' : 'Additional Questions'} (${state.questions.length}${state.isPollingQuestions && !state.questions.length ? '+' : ''})</span>
              </div>
              <span>${state.showQuestions ? '▴' : '▾'}</span>
            </button>
            ${state.showQuestions ? `
              <div class="box-body" style="padding-top:6px;">
                ${state.questions && state.questions.length ? state.questions.map((q, idx) => `
                  <div style="margin-bottom:8px;">
                    <label class="muted" style="display:block;margin-bottom:4px;color:#111827;">${escapeHtml(q.question)}</label>
                    <textarea class="input" data-qa-index="${idx}" rows="2" placeholder="${state.submittedAnswers && state.submittedAnswers.length ? 'Update your answer...' : 'Enter your answer...'}">${escapeHtml(q.answer || '')}</textarea>
                  </div>`).join('') : `
                  ${(state.currentPrompt && (state.currentPrompt.status === 'pending' || state.currentPrompt.status === 'processing')) || state.isPollingQuestions ? `
                    <div class="row" style="gap:8px;padding:8px;">
                      <span class="loading" style="width:16px;height:16px;border:2px solid #9ca3af;border-top-color:transparent;border-radius:50%;"></span>
                      <div class="grow">
                        <div style="font-size:13px;color:#374151;font-weight:600;">${(state.fileContexts && state.fileContexts.length) ? 'Processing questions...' : 'Retrieving questions...'}</div>
                        <div class="muted-sm">This may take a few moments</div>
                      </div>
                      ${state.currentPrompt ? `<div class="status ${getStatusColor((state.fileContexts && state.fileContexts.length) ? 'processing' : (state.currentPrompt.status || 'processing'))}">${(state.fileContexts && state.fileContexts.length) ? 'processing' : (state.currentPrompt.status || 'processing')}</div>` : ''}
                    </div>
                  ` : `
                    <div class="row" style="gap:8px;padding:8px;">
                      <div class="grow">
                        <div style="font-size:13px;color:#374151;font-weight:600;">No additional questions</div>
                        <div class="muted-sm">You're all set for this prompt</div>
                      </div>
                    </div>
                  `}
                `}
                ${state.questions && state.questions.length ? `
                  <div class="row" style="gap:8px;">
                    <button id="ctx-qa-submit" class="btn btn-primary grow" ${state.submittingAnswers ? 'disabled' : ''}>${state.submittingAnswers ? 'Submitting...' : ((state.submittedAnswers && state.submittedAnswers.length) || ((state.fileContexts && state.fileContexts.length) && (state.questions && state.questions.length)) ? 'Update' : 'Submit')}</button>
                    <button id="ctx-qa-skip" class="btn btn-outline">${state.submittedAnswers && state.submittedAnswers.length ? 'Cancel' : 'Skip'}</button>
                  </div>
                ` : ''}
              </div>` : ''}
          </div>` : ''}


        ${state.error ? `<div class="box" style="background:#fef2f2;border-color:#fecaca;margin-top:12px;"><div class="box-body" style="color:#991b1b;font-size:12px;">${state.error}</div></div>`: ""}
      </div>`;
  };

  const renderHistoryView = () => {
    return `
      <div class="section" style="display:flex;flex-direction:column;height:100%">
        <div class="box" style="display:flex;flex-direction:column;flex:1;">
          <div class="box-header" style="background:#fff;border-radius:8px 8px 0 0;">
            <div class="row" style="justify-content:space-between;">
              <button id="ctx-history-refresh" class="header-btn" ${state.historyLoading ? 'disabled' : ''} title="Refresh">${state.historyLoading ? `<span class="loading">${icon('refresh')}</span>` : icon('refresh')}</button>
              <div class="grow" style="margin-left:8px;"><input id="ctx-history-search" class="input" placeholder="Search prompts..." value="${escapeAttr(state.historySearch)}" /></div>
            </div>
          </div>
          <div class="box-body" style="flex:1;overflow:auto;padding:0;">
            ${state.historyLoading ? `<div style="text-align:center;" class="muted-sm">Loading history...</div>` :
              (state.promptHistory.length === 0 ? `<div style="text-align:center;" class="muted-sm">${state.historySearch ? 'No prompts match your filters' : 'No prompt history yet'}</div>` :
                state.promptHistory.map(p => `
                  <button class="row history-item" data-history-id="${p.id}" style="align-items:flex-start;width:100%;text-align:left;padding:8px;border:none;outline:none;appearance:none;border-bottom:1px solid #e5e7eb;">
                    <div class="grow">
                      <div style="font-size:12px;font-weight:600;color:#111827;margin-bottom:4px;">${escapeHtml(p.original_prompt)}</div>
                      <div class="row" style="gap:8px;">
                        <span class="status ${getStatusColor(p.status)}">${p.status}</span>
                        <span class="muted-sm">🕒 ${formatDate(p.created_at)}</span>
                      </div>
                      ${p.enriched_prompt ? `<div class="muted-sm" style="margin-top:4px;">Enhanced: ${escapeHtml((p.enriched_prompt || '').slice(0, 100))}...</div>` : ''}
                    </div>
                  </button>`).join('')
              )}
          </div>
        </div>
      </div>`;
  };

  const renderSettingsView = () => {
    return `
      <div class="section">
        <div style="margin-top:12px;">
          <label class="muted" style="display:block;margin-bottom:6px;font-weight:600;color:#111827;">API Key</label>
          <div style="position:relative;">
            <input id="ctx-settings-apikey" class="input" type="password" placeholder="Enter your API key" value="${escapeAttr(state.apiKey)}" style="padding-right:30px;" />
            <button id="ctx-settings-apikey-toggle" class="header-btn" title="Show/Hide" style="position:absolute; right:6px; top:50%; transform:translateY(-50%);">
              ${icon('eye')}
            </button>
          </div>
          <div class="muted-sm" style="margin-top:4px;">Your API key is stored locally in your browser</div>
        </div>

        ${state.error ? `<div class="box" style="background:#fef2f2;border-color:#fecaca;margin-top:12px;"><div class="box-body" style="color:#991b1b;font-size:12px;">${state.error}</div></div>`: ""}
        <div class="row" style="gap:8px;margin-top:12px;">
          <button id="ctx-settings-cancel" class="btn btn-outline grow" style="font-size:14px;font-weight:400;">Cancel</button>
          <button id="ctx-settings-save" class="btn btn-primary grow" style="font-size:14px;">Save</button>
        </div>
        ${state.isAuthenticated ? `<div class="divider" style="margin-top:16px;"></div>
          <button id="ctx-disconnect" class="btn" style="color:#dc2626;width:100%;background:transparent;font-size:14px;">Disconnect API Key</button>` : ''}
      </div>`;
  };

  const renderFooter = () => {
    if (!state.isAuthenticated || !state.enhancedPrompt || state.currentView !== "fetch") return "";
    const composite = state.enhancedPrompt + generateAdditionalContext() + generateFileContext() + generateQAContext();
    return `
      <div class="box" style="margin:0 12px 12px 12px;background:#f9fafb;border-top:1px solid #e5e7eb;">
        <div class="box-body row" style="justify-content:space-between;padding-bottom:8px;">
          <label style="font-weight:600;color:#16a34a;font-size:13px;">Enhanced Prompt</label>
          <button id="ctx-copy" class="row" style="gap:6px;color:${state.copiedPrompt ? '#16a34a' : '#2563eb'};background:transparent;border:none;">
            ${state.copiedPrompt ? icon('check') + '<span class="muted-sm" style="color:#16a34a;">Copied!</span>' : icon('copy') + '<span class="muted-sm">Copy</span>'}
          </button>
        </div>
        <div class="box-body" style="max-height:160px;overflow:auto;background:#fff;border-radius:8px;">
          <div class="code">${escapeHtml(composite)}</div>
        </div>
      </div>`;
  };

  const renderMain = () => {
    const header = `
      <div class="header">
        <div class="title"><span style="color:#2563eb;">${state.currentView === 'fetch' ? renderLogo(16) : state.currentView === 'history' ? icon('history') : icon('settings')}</span> ${renderHeaderTitle()}</div>
        <div class="actions">
          ${state.isAuthenticated && state.currentView === 'fetch' ? `<button id="ctx-new" class="btn btn-new">+ NEW</button>` : ''}
          <button id="ctx-fullscreen" title="Toggle Dashboard Size" class="header-btn">${state.isFullscreen ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-minimize2"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" x2="21" y1="10" y2="3"></line><line x1="3" x2="10" y1="21" y2="14"></line></svg>` : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-maximize2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" x2="14" y1="3" y2="10"></line><line x1="3" x2="10" y1="21" y2="14"></line></svg>`}</button>
          <button id="ctx-close" title="Close" class="header-btn">${icon('x')}</button>
        </div>
      </div>`;

    const status = renderStatusBar();
    const content = `
      <div class="content">
        ${state.currentView === 'settings' ? renderSettingsView() : state.currentView === 'history' ? renderHistoryView() : renderFetchView()}
      </div>`;

    const footer = renderFooter();

    const ribbon = `
      <div class="ribbon">
        <button id="ctx-collapse-toggle" title="${state.isCollapsed ? 'Expand' : 'Collapse'}">${state.isCollapsed ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-left w-4 h-4" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="m15 18-6-6 6-6"></path></svg>` : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right w-4 h-4" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><path d="m9 18 6-6-6-6"></path></svg>`}</button>
        <button id="ctx-nav-fetch" class="${state.currentView === 'fetch' ? 'active' : ''}" title="Fetch">${renderLogo(16)}</button>
        ${state.isAuthenticated ? `<button id=\"ctx-nav-history\" class=\"${state.currentView === 'history' ? 'active' : ''}\" title=\"History\">${icon('history')}</button>` : ''}
        <button id="ctx-nav-settings" class="${state.currentView === 'settings' ? 'active' : ''}" title="Settings">${icon('settings')}</button>
        <button id="ctx-nav-website" title="FetchContext.ai">${icon('brain')}</button>
      </div>`;

    const wrapperCls = `panel ${state.isFullscreen ? 'full' : ''} ${state.isCollapsed ? 'collapsed' : ''}`.trim();
    const reopenBtn = state.isOpen ? '' : `<button id="ctx-reopen" class="reopen-btn" title="Open">${renderLogo(20)}</button>`;
    container.innerHTML = `<div class="${wrapperCls}"${state.isOpen ? '' : ' style="display:none;"'}>${ribbon}<div class="main">${header}${status}${content}${footer}</div></div>${reopenBtn}`;

    bindEvents();
  };

  // Event binding
  const bindEvents = () => {
    // Header
    byId('ctx-close', false)?.addEventListener('click', () => { state.isCollapsed = true; render(); });
    byId('ctx-fullscreen', false)?.addEventListener('click', () => {
      if (!state.isFullscreen) {
        state.isFullscreen = true;
        state.isCollapsed = false;
      } else {
        state.isFullscreen = false;
        // Keep pane open at standard width when exiting fullscreen
        state.isCollapsed = false;
      }
      render();
    });
    
    byId('ctx-new', false)?.addEventListener('click', () => { resetPrompt(); render(); });

    // Nav
    byId('ctx-nav-fetch', false)?.addEventListener('click', () => { if (state.isCollapsed) state.isCollapsed = false; state.currentView = 'fetch'; render(); });
    byId('ctx-nav-history', false)?.addEventListener('click', () => { if (state.isCollapsed) state.isCollapsed = false; state.currentView = 'history'; if (!state.historyLoading) loadPromptHistory(); });
    byId('ctx-nav-settings', false)?.addEventListener('click', () => { if (state.isCollapsed) state.isCollapsed = false; state.currentView = 'settings'; render(); });
    byId('ctx-nav-website', false)?.addEventListener('click', () => {
      try { window.open('https://fetchcontext.ai', '_blank'); } catch (_) {}
    });
    byId('ctx-collapse-toggle', false)?.addEventListener('click', () => { state.isCollapsed = !state.isCollapsed; render(); });

    // Fetch view events
    const promptEl = byId('ctx-original-prompt', false);
    if (promptEl) {
      promptEl.addEventListener('input', (e) => {
        state.originalPrompt = e.target.value;
        resizeTextarea(e.target);
        const submitBtn = byId('ctx-submit', false);
        if (submitBtn) {
          const isDisabled = state.loading || !state.originalPrompt.trim() || !state.selectedSchemas.length;
          submitBtn.disabled = isDisabled;
          submitBtn.innerHTML = isDisabled ? icon('sendDisabled') : icon('send');
        }
      });
      // Ensure Enter inserts a newline and retains focus within the prompt textarea
      promptEl.addEventListener('keydown', (e) => {
        if (e && e.key === 'Enter') {
          try { e.preventDefault(); } catch(_) {}
          try { e.stopPropagation(); } catch(_) {}
          try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch(_) {}
          insertNewlineAtCursor(e.target);
        }
      });
    }

    // Capture-phase guard to block host page Enter handlers while typing in our prompt
    if (!globalEnterHandlerBound) {
      try {
        document.addEventListener('keydown', (e) => {
          try {
            if (e && e.key === 'Enter') {
              const target = e.target;
              // Only act if the event originates from our shadow DOM prompt textarea
              if (shadow && shadow.contains(target)) {
                const el = byId('ctx-original-prompt', false);
                if (el && target === el) {
                  try { e.preventDefault(); } catch(_) {}
                  try { e.stopPropagation(); } catch(_) {}
                  try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch(_) {}
                }
              }
            }
          } catch(_) {}
        }, true);
        globalEnterHandlerBound = true;
      } catch(_) {}
    }

    byId('ctx-toggle-context', false)?.addEventListener('click', () => {
      state.showContextSelection = !state.showContextSelection; render();
    });
    byId('ctx-close-context', false)?.addEventListener('click', () => { state.showContextSelection = false; state.contextSearchTerm = ""; render(); });
    const searchEl = byId('ctx-context-search', false);
    if (searchEl) searchEl.addEventListener('input', (e) => { state.contextSearchTerm = e.target.value; render(); });

    // Add/remove contexts
    container.querySelectorAll('[data-add-schema]')?.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-add-schema');
        if (!state.selectedSchemas.includes(id)) state.selectedSchemas.push(id);
        state.showContextSelection = false; state.contextSearchTerm = ""; render();
      });
    });
    container.querySelectorAll('[data-remove-schema]')?.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-remove-schema');
        state.selectedSchemas = state.selectedSchemas.filter(s => s !== id); render();
      });
    });

    byId('ctx-submit', false)?.addEventListener('click', submitPrompt);

    // File context toggle
    byId('ctx-filectx-toggle', false)?.addEventListener('click', () => {
      const contentEl = container.querySelector('.content');
      const prevContentScrollTop = contentEl ? contentEl.scrollTop : 0;
      state.showFileContext = !state.showFileContext;
      render();
      try {
        const newContentEl = container.querySelector('.content');
        if (newContentEl) newContentEl.scrollTop = prevContentScrollTop;
      } catch (_) {}
    });
    container.querySelectorAll('[data-filectx]')?.forEach(div => {
      div.addEventListener('click', (e) => {
        const listEl = byId('ctx-filectx-list', false);
        const prevScrollTop = listEl ? listEl.scrollTop : 0;
        const contentEl = container.querySelector('.content');
        const prevContentScrollTop = contentEl ? contentEl.scrollTop : 0;
        const id = e.currentTarget.getAttribute('data-filectx');
        const ctx = state.fileContexts.find(c => c.id === id);
        if (!ctx) return;
        ctx.selected = !ctx.selected;
        if (ctx.selected) {
          if (!state.selectedFileExtracts.includes(ctx.content)) state.selectedFileExtracts.push(ctx.content);
        } else {
          state.selectedFileExtracts = state.selectedFileExtracts.filter(x => x !== ctx.content);
        }
        render();
        try {
          const newListEl = byId('ctx-filectx-list', false);
          if (newListEl) newListEl.scrollTop = prevScrollTop;
          const newContentEl = container.querySelector('.content');
          if (newContentEl) newContentEl.scrollTop = prevContentScrollTop;
        } catch (_) {}
      });
    });


    // History
    byId('ctx-history-refresh', false)?.addEventListener('click', loadPromptHistory);
    const hs = byId('ctx-history-search', false);
    if (hs) {
      hs.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPromptHistory(); });
      hs.addEventListener('input', (e) => { state.historySearch = e.target.value; });
    }
    container.querySelectorAll('[data-history-id]')?.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-history-id');
        const prompt = state.promptHistory.find(p => String(p.id) === String(id));
        if (!prompt) return;
        resetPrompt();
        state.originalPrompt = prompt.original_prompt || "";
      state.currentPrompt = prompt;
      state.enhancedPrompt = prompt.enriched_prompt || "";
      state.selectedSchemas = Array.isArray(prompt.schemas_used) ? prompt.schemas_used : [];
      if (Array.isArray(prompt.questions_answers) && prompt.questions_answers.length) {
        state.questions = prompt.questions_answers;
        state.submittedAnswers = prompt.questions_answers;
      } else {
        state.questions = [];
        state.submittedAnswers = [];
      }
      if (prompt.context && Array.isArray(prompt.context)) {
          state.fileContexts = prompt.context.map((ctx, index) => ({ id: `${prompt.id}_${index}`, source: ctx.source, content: ctx.content, selected: false }));
        } else {
          state.fileContexts = [];
        }
        state.selectedFileExtracts = [];
        state.showQuestions = false; state.showFileContext = false; state.currentView = 'fetch';
        render();
      });
    });

    // Settings
    byId('ctx-settings-cancel', false)?.addEventListener('click', () => { state.currentView = 'fetch'; render(); });
    byId('ctx-settings-save', false)?.addEventListener('click', () => {
      const a = byId('ctx-settings-apikey');
      state.apiKey = a ? a.value : state.apiKey;
      state.isAuthenticated = !!(state.apiKey && state.apiKey.trim());
      saveLocal(); state.currentView = 'fetch'; state.error = null; if (state.isAuthenticated && ensureConfigured()) loadSchemas(); else render();
    });
    byId('ctx-settings-apikey-toggle', false)?.addEventListener('click', (e) => {
      e.preventDefault();
      const input = byId('ctx-settings-apikey');
      if (!input) return;
      const isPassword = input.getAttribute('type') === 'password';
      input.setAttribute('type', isPassword ? 'text' : 'password');
      const btn = byId('ctx-settings-apikey-toggle');
      if (btn) btn.innerHTML = isPassword ? icon('eyeOff') : icon('eye');
    });
    byId('ctx-disconnect', false)?.addEventListener('click', () => {
      try { localStorage.removeItem(STORAGE_KEYS.apiKey); } catch(_){}
      state.apiKey = ""; state.isAuthenticated = false; state.schemas = []; state.currentPrompt = null; state.enhancedPrompt = ""; state.questions = []; render();
    });

    // Registration CTA
    byId('ctx-register', false)?.addEventListener('click', () => {
      try { window.open('https://fetchcontext.ai', '_blank'); } catch (_) {}
    });

    // Connect on unauthenticated view
    byId('ctx-connect', false)?.addEventListener('click', () => {
      const a = byId('ctx-api-key');
      state.apiKey = a ? a.value : "";
      state.isAuthenticated = !!(state.apiKey && state.apiKey.trim());
      state.error = null;
      saveLocal();
      if (state.isAuthenticated && ensureConfigured()) loadSchemas(); else render();
    });
    byId('ctx-api-key-toggle', false)?.addEventListener('click', () => {
      const input = byId('ctx-api-key');
      if (!input) return;
      const isPassword = input.getAttribute('type') === 'password';
      input.setAttribute('type', isPassword ? 'text' : 'password');
      const btn = byId('ctx-api-key-toggle');
      if (btn) btn.textContent = isPassword ? 'Hide' : 'Show';
    });
    // Footer copy
    byId('ctx-copy', false)?.addEventListener('click', () => {
      const text = state.enhancedPrompt + generateAdditionalContext() + generateFileContext() + generateQAContext();
      copyToClipboard(text);
    });

    // Q&A events
    byId('ctx-qa-toggle', false)?.addEventListener('click', () => { state.showQuestions = !state.showQuestions; render(); });
    byId('ctx-qa-submit', false)?.addEventListener('click', submitAnswers);
    byId('ctx-qa-skip', false)?.addEventListener('click', () => { state.showQuestions = false; render(); });
    container.querySelectorAll('[data-qa-index]')?.forEach(ta => {
      ta.addEventListener('input', (e) => {
        const idxStr = e.currentTarget.getAttribute('data-qa-index');
        const idx = Number(idxStr);
        if (!isNaN(idx) && state.questions[idx]) {
          state.questions[idx].answer = e.target.value;
        }
      });
    });

    // Reopen floating button
    byId('ctx-reopen', false)?.addEventListener('click', () => { state.isOpen = true; render(); });
  };

  // Helpers
  const byId = (id, required = true) => {
    const node = container.querySelector(`#${id}`);
    if (!node && required) console.warn(`[Fetch Context] element #${id} not found`);
    return node || null;
  };

  const escapeHtml = (str) => (str || "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  const escapeAttr = (str) => (str || "").replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

  const resetPrompt = () => {
    state.originalPrompt = "";
    state.enhancedPrompt = "";
    state.currentPrompt = null;
    state.questions = [];
    state.submittedAnswers = [];
    state.submittingAnswers = false;
    state.selectedSchemas = [];
    state.error = null;
    state.fileContexts = [];
    state.selectedFileExtracts = [];
    state.showFileContext = false;
    state.showQuestions = false;
    state.isPollingQuestions = false;
    state.questionsPollAttempts = 0;
  };

  const resizeTextarea = (ta) => {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };

  const insertNewlineAtCursor = (ta) => {
    if (!ta) return;
    try {
      const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
      const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      ta.value = before + "\n" + after;
      const newPos = start + 1;
      try { ta.selectionStart = newPos; ta.selectionEnd = newPos; } catch(_) {}
      try { ta.focus(); } catch(_) {}
      state.originalPrompt = ta.value;
      resizeTextarea(ta);
      const submitBtn = byId('ctx-submit', false);
      if (submitBtn) {
        const isDisabled = state.loading || !state.originalPrompt.trim() || !state.selectedSchemas.length;
        submitBtn.disabled = isDisabled;
        submitBtn.innerHTML = isDisabled ? icon('sendDisabled') : icon('send');
      }
    } catch (_) {}
  };

  // Adjust host page layout to accommodate the preview pane width when expanded
  const getPanelWidth = () => {
    // Only offset when the panel is open and not collapsed
    if (!state.isOpen) return 0;
    if (state.isCollapsed) return 0;
    // When fullscreen, panel width is 60% of viewport
    if (state.isFullscreen) {
      try {
        const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
        return Math.floor(viewportWidth * 0.60);
      } catch (_) {
        return 0;
      }
    }
    // Otherwise, use actual panel width (or fallback)
    try {
      const panel = shadow && shadow.querySelector ? shadow.querySelector('.panel') : null;
      if (panel) {
        const rect = panel.getBoundingClientRect();
        if (rect && rect.width) return Math.round(rect.width);
      }
    } catch (_) {}
    // Fallback to default expanded width
    return 480;
  };

  const updatePageOffset = () => {
    try {
      const width = getPanelWidth();
      const htmlEl = document.documentElement;
      if (!htmlEl) return;
      if (width > 0) {
        htmlEl.style.marginRight = width + 'px';
      } else {
        htmlEl.style.marginRight = '';
      }
      // No scaling of the page; we purely offset using margin-right
    } catch (_) {}
  };

  const render = () => {
    ensureRoot();
    renderMain();
    updatePageOffset();
    // Also recompute after next frame to account for layout changes
    try { requestAnimationFrame(() => { try { updatePageOffset(); } catch(_) {} }); } catch(_) {}
  };

  // Init
  loadLocal();
  ensureRoot();
  render();
  if (state.isAuthenticated) loadSchemas();
})();

