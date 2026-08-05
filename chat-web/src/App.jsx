import { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { chat, getBots, createBot, deleteBot, updateBot, healthCheck, getSettings, updateSettings, resetSettings, sendTestEmail, getBotSettings, updateBotSettings, resetBotSettings, sendBotTestEmail, botChat, getBotKnowledge, uploadBotFile, deleteBotSource, getModels, getBotModels, getBotSourceDownloadUrl, getFunctions } from './api.js';

/* ─── Message Bubble ──────────────────── */
function MessageBubble({ msg, botName }) {
  const isUser = msg.role === 'user';

  return (
    <div className={`message ${isUser ? 'user' : 'bot'}`}>
      {!isUser && <div className="label">🤖 {botName || 'Bot'}</div>}
      {isUser && <div className="label">Tú</div>}
      <div className="bubble">{msg.text}</div>
    </div>
  );
}

/* ─── Typing Indicator ────────────────── */
function TypingIndicator({ botName }) {
  return (
    <div className="message bot">
      <div className="label">🤖 {botName || 'Bot'}</div>
      <div className="bubble">
        <div className="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  );
}

/* ─── Chat Panel ──────────────────────── */
function ChatPanel({ online, botId, botName, checking, onRetry, error, hasBots }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [welcome, setWelcome] = useState('');
  const messagesEnd = useRef(null);
  const queue = useRef([]);
  const sending = useRef(false);

  const scrollToBottom = useCallback(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const chatFn = botId ? (q) => botChat(botId, q) : (q) => chat(q);

  useEffect(() => scrollToBottom(), [messages, loading]);

  // Al cambiar de bot: resetear chat y cargar su mensaje de bienvenida
  useEffect(() => {
    setMessages([]);
    setInput('');
    setQueueCount(0);
    queue.current = [];
    setWelcome('');
    if (botId) {
      getBotSettings(botId)
        .then((s) => setWelcome(s.welcomeMessage || ''))
        .catch(() => setWelcome(''));
    } else {
      setWelcome('');
    }
  }, [botId]);

  const sendOne = useCallback(async (text) => {
    sending.current = true;
    setLoading(true);
    try {
      const data = await chatFn(text);
      setMessages((prev) => [
        ...prev,
        { role: 'bot', text: data.answer, chunks: data.chunks_used || [] },
      ]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'bot', text: '❌ ' + err.message }]);
    } finally {
      setLoading(false);
      sending.current = false;
    }
  }, [chatFn]);

  // When the bot finishes a response, send the next queued message (if any)
  useEffect(() => {
    if (!loading && !sending.current && queue.current.length > 0) {
      const next = queue.current.shift();
      setQueueCount(queue.current.length);
      sendOne(next);
    }
  }, [loading, sendOne]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || !online) return;

    setInput('');

    if (loading || sending.current) {
      // Enqueue: show message immediately, send after current response
      setMessages((prev) => [...prev, { role: 'user', text }]);
      queue.current.push(text);
      setQueueCount(queue.current.length);
    } else {
      setMessages((prev) => [...prev, { role: 'user', text }]);
      sendOne(text);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-panel">
      <div className="messages">
        {!online && (
          <div className="connect-screen">
            <div className={`connect-spinner${checking ? '' : ' slow'}`} />
            <div className="connect-title">
              {online === null ? 'Conectando con el servidor...' : 'Servidor no disponible'}
            </div>
            <div className="connect-hint">
              {online === null
                ? 'El servidor puede estar despertando (Render free tarda ~30s). No cierres la página.'
                : error || 'Verifica tu conexión o que el backend esté levantado.'}
            </div>
            <button
              className="btn btn-primary"
              onClick={onRetry}
              disabled={checking}
            >
              {checking ? '⏳ Reintentando...' : '↻ Reintentar'}
            </button>
          </div>
        )}
        {online && !botId && !hasBots && (
          <div className="connect-screen">
            <div className="connect-title">🤖 No tienes bots aún</div>
            <div className="connect-hint">
              Crea un bot desde el panel lateral (<strong>+ Nuevo Bot</strong>) para empezar a chatear.
            </div>
          </div>
        )}
        {online && messages.length === 0 && welcome && (
          <div className="message bot">
            <div className="label">🤖 {botName || 'Bot'}</div>
            <div className="bubble">{welcome}</div>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} botName={botName} />
        ))}
        {loading && <TypingIndicator botName={botName} />}
        <div ref={messagesEnd} />
      </div>

      <div className="input-area">
        <input
          type="text"
          placeholder={
            !online ? 'Servicio no disponible — esperando conexión...' :
            !botId ? 'Selecciona o crea un bot para empezar...' :
            'Escribe tu mensaje...'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!online || !botId}
        />
        <button
          className="btn btn-primary"
          onClick={handleSend}
          disabled={!online || !input.trim() || !botId}
        >
          {loading ? '⏳' : 'Enviar'}
        </button>
      </div>
      {queueCount > 0 && (
        <div className="queue-indicator">
          ⏳ {queueCount} mensaje{queueCount > 1 ? 's' : ''} encolado{queueCount > 1 ? 's' : ''} — se enviarán en cuanto termine la respuesta
        </div>
      )}
    </div>
  );
}

/* ─── Upload Panel ────────────────────── */
function UploadPanel({ onRefresh }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      await handleUpload(file);
    } else {
      setStatus('Solo se aceptan archivos PDF');
    }
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (file) await handleUpload(file);
  };

  const handleUpload = async (file) => {
    setUploading(true);
    setStatus(`Subiendo ${file.name}...`);
    setProgress(10);

    try {
      const result = await ingestPdf(file);
      setStatus('Procesando... extrayendo texto');

      // Poll until done
      let done = false;
      let attempts = 0;
      while (!done && attempts < 60) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;
        try {
          const src = await getSource(result.source_id);
          setProgress(src.last_job?.progress || progress);
          setStatus(src.last_job?.status || 'procesando');
          if (src.last_job?.status === 'completed') {
            done = true;
            setStatus('✅ ¡Ingesta completada!');
            onRefresh?.();
          } else if (src.last_job?.status === 'failed') {
            done = true;
            setStatus('❌ Error: ' + (src.last_job?.error_message || 'desconocido'));
          }
        } catch {
          // still polling
        }
      }
      if (!done) setStatus('⏱️ Timeout — revisa manualmente');
    } catch (err) {
      setStatus('❌ Error: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="sidebar-section">
      <h3>📄 Subir conocimiento</h3>
      <div
        className={`upload-zone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById('file-input').click()}
      >
        {uploading ? '⏳ Procesando...' : 'Arrastra un PDF aquí\n o haz clic para seleccionar'}
        <input
          id="file-input"
          type="file"
          accept=".pdf"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
      </div>
      {uploading && (
        <div className="upload-progress">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="upload-status">{status}</div>
        </div>
      )}
      {status && !uploading && <div className="upload-status">{status}</div>}
    </div>
  );
}

/* ─── Source List ─────────────────────── */
function SourceList({ refreshKey }) {
  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [sourceDetail, setSourceDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const data = await getSources();
      setSources(data);
    } catch {
      // silently fail
    }
  }, []);

  // Carga al montar y cuando se pide refresco (subida de PDF o botón ↻)
  useEffect(() => {
    loadSources();
  }, [loadSources, refreshKey]);

  const handleSelect = async (source) => {
    if (selectedSource?.id === source.id) {
      setSelectedSource(null);
      setSourceDetail(null);
      return;
    }
    setSelectedSource(source);
    setLoading(true);
    try {
      const detail = await getSource(source.id);
      setSourceDetail(detail);
    } catch {
      setSourceDetail(null);
    } finally {
      setLoading(false);
    }
  };

  const statusBadge = (status) => {
    const cls = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'processing';
    return <span className={`badge ${cls}`}>{status}</span>;
  };

  return (
    <>
      <div className="sidebar-section source-header">
        <h3>📚 Base de conocimiento ({sources.length})</h3>
        <button className="btn btn-secondary btn-sm" onClick={loadSources} title="Refrescar lista">
          ↻
        </button>
      </div>
      <div className="source-list">
        {sources.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--gray-200)', padding: 10 }}>
            No hay documentos. Sube un PDF para empezar.
          </div>
        )}
        {sources.map((s) => (
          <div key={s.id}>
            <div className="source-card" onClick={() => handleSelect(s)}>
              <div className="source-title">{s.title}</div>
              <div className="source-meta">
                {statusBadge(s.status)}
                <span>{s.original_filename}</span>
              </div>
            </div>
            {selectedSource?.id === s.id && sourceDetail && (
              <div className="source-detail">
                <p style={{ fontSize: 12, marginBottom: 8, color: 'var(--gray-200)' }}>
                  {sourceDetail.documents?.[0]?.page_count} páginas · {sourceDetail.documents?.[0]?.char_count} caracteres
                </p>
                {sourceDetail.documents?.[0]?.chunks?.map((c) => (
                  <div key={c.id} className="chunk-item">
                    <div className="chunk-header">
                      <span>Fragmento {c.index}</span>
                      <span>{c.char_count} chars {c.has_embedding ? '✓' : '✗'}</span>
                    </div>
                    <div>{c.content_preview}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ─── Settings Panel (admin) ───────────── */
function SliderRow({ label, hint, value, min, max, step, onChange, info }) {
  return (
    <div className="settings-row">
      <div className="row-top">
        <label>{label}{info && <InfoTip text={info} />}</label>
        <span className="value">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hint && <p className="settings-hint">{hint}</p>}
    </div>
  );
}

function SettingsPanel({ open, onClose, botId, botName, creating, onCreated, onBotUpdated }) {
  const [settings, setSettings] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [botNameInput, setBotNameInput] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [tab, setTab] = useState('chat');
  // Inline name editing
  const [nameEdit, setNameEdit] = useState(false);
  const [nameValue, setNameValue] = useState('');
  // Knowledge tab
  const [sources, setSources] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [deletingSource, setDeletingSource] = useState(null);
  // DeepSeek models
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Calling functions catalog
  const [functionCatalog, setFunctionCatalog] = useState([]);
  // Última versión GUARDADA de settings (para detectar cambios sin guardar)
  const originalRef = useRef(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    const justOpened = !wasOpen.current;
    wasOpen.current = true;

    setMsg('');
    setTestResult('');
    setBotNameInput(botId ? (botName || '') : '');
    if (justOpened) {
      setTab('model');
      setNameEdit(false);
      setNameValue(botName || '');
    }
    const fetchSettings = botId ? getBotSettings(botId) : getSettings();
    fetchSettings
      .then((data) => { setSettings(data); originalRef.current = data; })
      .catch((e) => setMsg('❌ No se pudo cargar: ' + e.message));
    // Cargar fuentes de conocimiento si hay botId
    if (botId) {
      getBotKnowledge(botId).then(setSources).catch(() => {});
    } else {
      setSources([]);
    }
    // Cargar modelos disponibles desde la API de DeepSeek
    setModelsLoading(true);
    (botId ? getBotModels(botId) : getModels())
      .then((d) => setModels(d.models || []))
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
    // Cargar catálogo de calling functions
    getFunctions()
      .then((d) => setFunctionCatalog(d.functions || []))
      .catch(() => setFunctionCatalog([]));
  }, [open, botId, botName]);

  if (!open || !settings) return null;

  const set = (key, value) => setSettings((s) => ({ ...s, [key]: value }));

  /** ¿Hay cambios sin guardar respecto a la última versión cargada/guardada? */
  const hasChanges = () =>
    !!settings && !!originalRef.current &&
    JSON.stringify(settings) !== JSON.stringify(originalRef.current);

  /** Cierra el modal; si hay cambios sin guardar, pide confirmación. */
  const requestClose = () => {
    if (uploading || saving) return;
    if (hasChanges()) setConfirmClose(true);
    else onClose();
  };

  /** Desde la confirmación: guardar y cerrar. */
  const confirmSaveAndClose = async () => {
    setConfirmClose(false);
    await save();
  };

  /** Desde la confirmación: descartar cambios y cerrar. */
  const confirmDiscard = () => {
    setConfirmClose(false);
    onClose();
  };

  const addEmail = () => {
    const email = newEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMsg('❌ Correo inválido');
      return;
    }
    if (settings.escalationEmails.includes(email)) {
      setMsg('❌ Ese correo ya está en la lista');
      return;
    }
    set('escalationEmails', [...settings.escalationEmails, email]);
    setNewEmail('');
    setMsg('');
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // En modo creación: crear el bot automáticamente para poder subir archivos
    let currentBotId = botId;
    if (creating && !currentBotId) {
      const name = botNameInput.trim() || 'Nuevo Bot';
      try {
        const { bot } = await createBot(name, '');
        currentBotId = bot.id;
        await updateBotSettings(bot.id, settings);
        onCreated(bot); // transiciona a modo edición con el bot recién creado
      } catch (err) {
        setMsg('❌ Error al crear el bot: ' + err.message);
        return;
      }
    }

    if (!currentBotId) return;
    setUploading(true);
    setMsg('⏳ Subiendo archivo...');
    try {
      await uploadBotFile(currentBotId, file);
      setMsg('⏳ Extrayendo conocimiento...');
      // La API espera a que termine el procesamiento antes de responder
      setSources(await getBotKnowledge(currentBotId));
      setMsg('✅ Archivo procesado. El conocimiento ya está disponible.');
    } catch (err) {
      setMsg('❌ ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteSource = (sourceId) => {
    if (!botId) return;
    setDeletingSource(sourceId);
  };

  const confirmDeleteSource = async () => {
    if (!botId || !deletingSource) return;
    try {
      await deleteBotSource(botId, deletingSource);
      setSources((prev) => prev.filter((s) => s.id !== deletingSource));
      setDeletingSource(null);
    } catch (e) {
      setMsg('❌ ' + e.message);
      setDeletingSource(null);
    }
  };

  const saveInlineName = async () => {
    const newName = nameValue.trim();
    if (!botId || !newName || newName === (botName || '')) {
      setNameEdit(false);
      return;
    }
    try {
      await updateBot(botId, { name: newName });
      onBotUpdated?.();
      setNameEdit(false);
      setMsg('✅ Nombre actualizado');
    } catch (e) {
      setMsg('❌ ' + e.message);
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const name = botNameInput.trim();
      if (creating) {
        if (!name) {
          setMsg('❌ Escribe un nombre para el bot');
          setSaving(false);
          return;
        }
        const { bot } = await createBot(name, '');
        await updateBotSettings(bot.id, settings);
        originalRef.current = settings; // lo recién creado queda como base
        onCreated(bot); // el padre lo agrega, lo selecciona y pasa a modo edición
        setMsg('✅ Bot creado. Ahora puedes subir su conocimiento y ajustar lo que quieras.');
      } else {
        // Si el nombre cambió, actualizarlo en la tabla bots
        if (botId && name && name !== (botName || '')) {
          await updateBot(botId, { name });
          onBotUpdated?.();
        }
        const saved = botId ? await updateBotSettings(botId, settings) : await updateSettings(settings);
        setSettings(saved);
        originalRef.current = saved;
        onClose();
      }
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('¿Restablecer todos los valores a los predeterminados?')) return;
    setSaving(true);
    setMsg('');
    try {
      setSettings(botId ? await resetBotSettings(botId) : await resetSettings());
      setMsg('✅ Valores restablecidos');
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult('');
    try {
      const res = botId ? await sendBotTestEmail(botId) : await sendTestEmail();
      if (res.ok) {
        setTestResult('✅ Correo enviado a: ' + res.results.map((r) => r.to).join(', '));
      } else {
        const failed = res.results.filter((r) => !r.ok);
        setTestResult('❌ Falló: ' + failed.map((r) => r.to + ': ' + r.error).join(' | '));
      }
    } catch (e) {
      setTestResult('❌ ' + e.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={uploading || saving ? undefined : requestClose}>
      <div className="modal modal-config" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {creating || nameEdit ? (
            <input
              className="bot-name-input"
              type="text"
              placeholder="Nombre del bot"
              value={creating ? botNameInput : nameValue}
              onChange={(e) => creating ? setBotNameInput(e.target.value) : setNameValue(e.target.value)}
              onBlur={() => !creating && saveInlineName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (creating) save();
                  else saveInlineName();
                }
              }}
              autoFocus
              style={{ flex: 1, maxWidth: '65%', fontSize: 15, fontWeight: 600, color: 'var(--gold-light)', background: 'transparent', border: 'none', borderBottom: '1px solid var(--gold-light)', borderRadius: 0, padding: '4px 0' }}
            />
          ) : (
            <div className="modal-title-group">
              <h2>{botName || (creating ? 'Nuevo Bot' : 'Configuración')}</h2>
              {botId && (
                <button
                  className="title-edit-btn"
                  onClick={() => { setNameEdit(true); setNameValue(botName || ''); }}
                  title="Editar nombre"
                  aria-label="Editar nombre"
                >✏️</button>
              )}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={requestClose} disabled={uploading || saving}>✕</button>
        </div>
        <div className="settings-tabs">
          <button className={`tab-btn${tab === 'model' ? ' active' : ''}`} onClick={() => setTab('model')}>🧠 Modelo</button>
          <button className={`tab-btn${tab === 'knowledge' ? ' active' : ''}`} onClick={() => setTab('knowledge')}>📚 Conocimiento</button>
          <button className={`tab-btn${tab === 'functions' ? ' active' : ''}`} onClick={() => setTab('functions')}>🛠️ Funciones</button>
          <button className={`tab-btn${tab === 'notifications' ? ' active' : ''}`} onClick={() => setTab('notifications')}>📧 Notificaciones</button>
          <button className={`tab-btn${tab === 'whatsapp' ? ' active' : ''}`} onClick={() => setTab('whatsapp')}>📱 WhatsApp</button>
          <button className={`tab-btn${tab === 'chat' ? ' active' : ''}`} onClick={() => setTab('chat')}>📨 Chat</button>
        </div>
        <div className="modal-body">

          {tab === 'model' && (
            <div className="settings-section">
              <h3>🧠 Configuración del modelo</h3>
              <div className="settings-row">
                <div className="row-top">
                  <label>Modelo DeepSeek <InfoTip text="Modelo de DeepSeek que se usará para generar respuestas. deepseek-chat = más potente (recomendado). deepseek-v4-flash = más rápido y barato. La lista se consulta automáticamente desde tu API key." /></label>
                  <span className="value">{settings.model}</span>
                </div>
                <select
                  className="model-select"
                  value={settings.model}
                  onChange={(e) => set('model', e.target.value)}
                  disabled={modelsLoading && models.length === 0}
                >
                  {modelsLoading && models.length === 0 && (
                    <option value={settings.model}>⏳ Consultando modelos...</option>
                  )}
                  {!modelsLoading && models.length === 0 && (
                    <option value={settings.model}>{settings.model || 'Sin modelos disponibles'}</option>
                  )}
                  {settings.model && !models.some((m) => m.id === settings.model) && models.length > 0 && (
                    <option value={settings.model}>{settings.model} (actual)</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </select>
              </div>
              <SliderRow
                label="Creatividad (temperature)"
                hint="Más alto = respuestas más variadas; más bajo = más consistentes."
                info="Controla qué tan creativo o determinista es el modelo. 0 = siempre responde igual, 1.5 = respuestas muy variadas e impredecibles. Valor recomendado: 0.7"
                value={settings.temperature}
                min={0} max={1.5} step={0.05}
                onChange={(v) => set('temperature', v)}
              />
              <SliderRow
                label="Fragmentos de conocimiento (top_k)"
                hint="Cuántos fragmentos del conocimiento se usan por respuesta."
                info="Número de chunks del PDF que se pasan al modelo como contexto. Más fragmentos = más contexto pero más tokens y latencia. Valor recomendado: 3-5"
                value={settings.topK}
                min={1} max={10} step={1}
                onChange={(v) => set('topK', v)}
              />
              <SliderRow
                label="Mensajes de contexto (historial)"
                hint="Turnos previos que se envían al modelo para mantener el contexto."
                info="Cantidad de mensajes anteriores (usuario + bot) que se mantienen en la memoria de la conversación. Más mensajes = mejor contexto pero más tokens. Valor recomendado: 6"
                value={settings.maxHistoryMessages}
                min={1} max={30} step={1}
                onChange={(v) => set('maxHistoryMessages', v)}
              />
              <SliderRow
                label="Confianza mínima de búsqueda"
                hint="Similitud mínima (0-1) para considerar un fragmento relevante."
                info="Umbral de similitud semántica. Solo los fragmentos con similitud >= este valor se pasan al modelo. 0 = devolver todos (más ruido), 1 = solo matches perfectos (casi nada). Valor recomendado: 0.05-0.15"
                value={settings.minConfidence}
                min={0} max={1} step={0.05}
                onChange={(v) => set('minConfidence', v)}
              />
              <SliderRow
                label="Máximo de tokens por respuesta"
                hint="Tope de tokens de la primera respuesta del modelo."
                info="Límite de tokens (palabras) que el modelo puede generar en su respuesta. Si la respuesta se corta, el sistema reintenta con más tokens. Valor recomendado: 2000-4000"
                value={settings.maxTokens}
                min={256} max={8192} step={128}
                onChange={(v) => set('maxTokens', v)}
              />
              <SliderRow
                label="Intentos sin respuesta clara"
                hint="Si el bot falla N veces seguidas, ofrece asesor. 0 = desactivado."
                info="Número de veces que el bot puede no encontrar información antes de ofrecer contactar a un asesor automáticamente. Útil para evitar que el usuario se frustre. 0 = nunca ofrece asesor automático."
                value={settings.maxNegativeResponses}
                min={0} max={20} step={1}
                onChange={(v) => set('maxNegativeResponses', v)}
              />
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.useReranker}
                  onChange={(e) => set('useReranker', e.target.checked)}
                />
                <span>Usar reranker (DeepSeek V4 Pro) en la búsqueda <InfoTip text="Cuando está activo, los fragmentos recuperados se re-evalúan con DeepSeek V4 Pro para mejorar la relevancia. Aumenta la calidad de las respuestas pero añade ~1-2s de latencia." /></span>
              </label>

              <h3 style={{ marginTop: 24 }}>📝 Prompt / Instrucciones <InfoTip text="Define la personalidad, tono y reglas del bot. Usa {context} como marcador — se reemplazará automáticamente con la información del PDF que subas. Si lo dejás vacío, el bot usa un prompt general predefinido." /></h3>
              <p className="settings-hint">
                Define la personalidad y comportamiento del bot. Usa <code>{'{context}'}</code> como
                marcador donde se insertará automáticamente la información del PDF subido.
              </p>
              <textarea
                className="bot-name-input"
                rows={16}
                style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
                placeholder="Eres un asistente que..."
                value={settings.systemPrompt || ''}
                onChange={(e) => set('systemPrompt', e.target.value)}
              />
            </div>
          )}

          {tab === 'notifications' && (
            <div className="settings-section">
              <h3>📧 Notificación a asesores <InfoTip text="Cuando un cliente pide hablar con una persona real, el sistema envía un correo a todos los asesores configurados aquí. Podés agregar varios." /></h3>
              <p className="settings-hint">
                Correos que reciben el aviso cuando un cliente pide hablar con un asesor.
              </p>
              {settings.escalationEmails.map((email, i) => (
                <div className="email-row" key={i}>
                  <span>{email}</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                      set('escalationEmails', settings.escalationEmails.filter((_, j) => j !== i))
                    }
                  >
                    Quitar
                  </button>
                </div>
              ))}
              <div className="email-add">
                <input
                  type="email"
                  placeholder="asesor@correo.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addEmail()}
                />
                <button className="btn btn-primary btn-sm" onClick={addEmail}>Agregar</button>
              </div>
              <div className="email-add">
                <span className="email-add-label">Remitente <InfoTip text="Dirección de correo que aparece como remitente. Debe usar un dominio verificado en Resend (resend.com/domains). Si aún no tenés dominio, usá onboarding@resend.dev para pruebas (solo envía a tu propio email)." /></span>
                <input
                  type="email"
                  placeholder="bot@tudominio.com"
                  value={settings.senderEmail}
                  onChange={(e) => set('senderEmail', e.target.value)}
                />
              </div>
              <div className="email-add">
                <span className="email-add-label">API Key <InfoTip text="API Key de Resend. La encontrás en resend.com → Settings → API Keys. Formato: re_XXXX..." /></span>
                <input
                  type="password"
                  placeholder="re_..."
                  value={settings.resendApiKey}
                  onChange={(e) => set('resendApiKey', e.target.value)}
                />
              </div>
              <p className="settings-hint">
                El remitente debe usar un dominio verificado en Resend. Puedes probar con
                onboarding@resend.dev mientras verificas tu dominio.
              </p>
              <button className="btn btn-secondary btn-sm" onClick={test} disabled={testing}>
                {testing ? 'Enviando...' : '📨 Enviar correo de prueba'}
              </button>
              {testResult && <div className="settings-status">{testResult}</div>}
            </div>
          )}

          {tab === 'chat' && (
            <div className="settings-section">
              <h3>📨 Mensaje de bienvenida <InfoTip text="Primer mensaje que ve el usuario al iniciar chat con este bot. Si se deja vacío, no se muestra ningún saludo. Podés usar emojis y saltos de línea." /></h3>
              <p className="settings-hint">
                Mensaje que muestra el bot al iniciar una conversación nueva. Si se deja vacío, no se muestra ningún saludo.
              </p>
              <textarea
                className="bot-name-input"
                rows={4}
                style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
                placeholder="¡Hola! ¿En qué puedo ayudarte?"
                value={settings.welcomeMessage || ''}
                onChange={(e) => set('welcomeMessage', e.target.value)}
              />
            </div>
          )}

          {tab === 'functions' && (
            <div className="settings-section">
              <h3>🛠️ Calling functions</h3>
              <p className="settings-hint">
                Selecciona las funciones que este bot puede ejecutar. Si desactivas una,
                el modelo no podrá usarla en sus respuestas.
              </p>
              {functionCatalog.map((fn) => {
                const enabled = settings.enabledFunctions || [];
                const checked = enabled.length === 0 || enabled.includes(fn.name);
                return (
                  <label
                    key={fn.name}
                    className="toggle-row"
                    style={{ alignItems: 'flex-start', gap: 10, marginBottom: 10 }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const current = settings.enabledFunctions || [];
                        const all = functionCatalog.map((f) => f.name);
                        const active = new Set(current.length === 0 ? all : current);
                        if (active.has(fn.name)) active.delete(fn.name);
                        else active.add(fn.name);
                        set('enabledFunctions', all.filter((n) => active.has(n)));
                      }}
                    />
                    <span style={{ flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 13 }}>{fn.label}</span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--gray-200)' }}>{fn.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {tab === 'knowledge' && (
            <>
              <div className="settings-section">
                <h3>📁 Archivos cargados ({sources.length})</h3>
                {creating && sources.length === 0 && (
                  <p className="settings-hint">
                    Sube archivos para entrenar al bot. Al subir el primero se creará el bot automáticamente.
                  </p>
                )}
                {!creating && sources.length === 0 && (
                  <p className="settings-hint">No hay archivos. Sube uno para entrenar al bot.</p>
                )}
                {sources.map((s) => (
                  <div key={s.id} className="source-row">
                    <div>
                      <div style={{ fontSize: 13 }}>{s.title || s.original_filename}</div>
                      <div style={{ fontSize: 11, color: 'var(--gray-200)' }}>
                        {s.status} · {s.file_type} {s.file_size_bytes ? `· ${(s.file_size_bytes / 1024).toFixed(1)} KB` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {s.file_available ? (
                        <a
                          className="btn btn-secondary btn-sm"
                          href={botId ? getBotSourceDownloadUrl(botId, s.id) : '#'}
                          download
                          title="Descargar archivo"
                        >⬇️</a>
                      ) : (
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ opacity: 0.4 }}
                          title="Archivo no disponible para descarga"
                          onClick={() => setMsg('📁 Este archivo no está disponible para descarga. Solo se conserva en Cloudinary (plan gratuito: máximo 10 MB).')}
                        >⬇️</button>
                      )}
                      <button className="btn btn-secondary btn-sm" onClick={() => handleDeleteSource(s.id)}>🗑️</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="settings-section">
                <label className="btn btn-primary btn-block" style={{ cursor: 'pointer', textAlign: 'center', display: 'block' }}>
                  {uploading ? '⏳ Subiendo...' : creating ? '📤 Subir archivo (se creará el bot automáticamente)' : '📤 Subir archivo'}
                  <input type="file" accept=".pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.html,.json,.xml,.yaml,.yml,.py,.js,.ts,.java,.cpp,.odt,.ods,.odp,.rtf" style={{ display: 'none' }} onChange={handleUpload} disabled={uploading} />
                </label>
              </div>
              <div className="settings-section">
                <h3>🔍 Búsqueda (RAG)</h3>
                <SliderRow label="Fragmentos (top_k)" hint="Fragmentos usados por respuesta." info="Número de chunks del conocimiento que se recuperan y se pasan al modelo como contexto." value={settings.topK} min={1} max={10} step={1} onChange={(v) => set('topK', v)} />
                <SliderRow label="Confianza mínima" hint="Similitud mínima para considerar un fragmento." info="Umbral de similitud semántica (0-1). Solo los fragmentos con puntuación >= este valor se consideran relevantes. 0.05 = casi todo, 0.5 = solo matches fuertes." value={settings.minConfidence} min={0} max={1} step={0.05} onChange={(v) => set('minConfidence', v)} />
                <label className="toggle-row">
                  <input type="checkbox" checked={settings.useReranker} onChange={(e) => set('useReranker', e.target.checked)} />
                  <span>Usar reranker <InfoTip text="Re-evalúa los fragmentos con DeepSeek V4 Pro para mejorar la precisión. Más lento pero más relevante." /></span>
                </label>
              </div>
            </>
          )}

          {tab === 'whatsapp' && (
            <>
              <div className="settings-section">
                <h3>🔗 Conexión WhatsApp</h3>
                <p className="settings-hint">
                  Credenciales de Meta for Developers.{' '}
                  <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started" target="_blank" rel="noopener" style={{ color: 'var(--gold-light)' }}>
                    Guía oficial →
                  </a>
                </p>

                <label className="settings-label">App ID <InfoTip text="Ve a Meta for Developers → Mis Apps → [tu app] → Configuración → Básica → App ID." /></label>
                <input className="bot-name-input" type="text" placeholder="123456789" value={settings.whatsappAppId} onChange={(e) => set('whatsappAppId', e.target.value)} style={{ marginBottom: 8, width: '100%' }} />

                <label className="settings-label">App Secret <InfoTip text="En el mismo lugar que el App ID (Configuración → Básica). Requiere verificación 2FA de Meta para verlo." /></label>
                <input className="bot-name-input" type="password" placeholder="••••••••" value={settings.whatsappAppSecret} onChange={(e) => set('whatsappAppSecret', e.target.value)} style={{ marginBottom: 8, width: '100%' }} />

                <label className="settings-label">WABA ID <InfoTip text="Ve a Meta Business Suite → WhatsApp Manager → tu cuenta de WhatsApp Business. El WABA ID sale en la URL o en 'Configuración de la cuenta'." /></label>
                <input className="bot-name-input" type="text" placeholder="123456789" value={settings.whatsappWabaId} onChange={(e) => set('whatsappWabaId', e.target.value)} style={{ marginBottom: 8, width: '100%' }} />

                <label className="settings-label">Phone Number ID <InfoTip text="En WhatsApp Manager → Teléfonos → selecciona tu número → copia el Phone Number ID (no es el número de teléfono, es un ID numérico)." /></label>
                <input className="bot-name-input" type="text" placeholder="123456789" value={settings.whatsappPhoneNumberId} onChange={(e) => set('whatsappPhoneNumberId', e.target.value)} style={{ marginBottom: 8, width: '100%' }} />

                <label className="settings-label">Access Token <InfoTip text="En Meta for Developers → [tu app] → WhatsApp → API Setup. Genera un token de acceso temporal (24h) o permanente. Requiere permisos: whatsapp_business_messaging y whatsapp_business_management. Si no lo pones, el sistema intenta generar uno automáticamente." /></label>
                <input className="bot-name-input" type="password" placeholder="EAA..." value={settings.whatsappAccessToken} onChange={(e) => set('whatsappAccessToken', e.target.value)} style={{ marginBottom: 8, width: '100%' }} />

                <label className="settings-label">Verify Token (webhook) <InfoTip text="Crea un token secreto cualquiera (ej: 'mi-token-2024'). En Meta, en Configuración del Webhook, pega este mismo token. Meta lo usará para verificar que el webhook es tuyo." /></label>
                <input className="bot-name-input" type="text" placeholder="mi-token-secreto" value={settings.whatsappVerifyToken} onChange={(e) => set('whatsappVerifyToken', e.target.value)} style={{ marginBottom: 8, width: '100%' }} />

                <label className="settings-label">Número de teléfono <InfoTip text="El número de WhatsApp Business registrado con el prefijo del país. Ej: +573001234567. Debe ser el número asociado al WABA y Phone Number ID ingresados arriba." /></label>
                <input className="bot-name-input" type="text" placeholder="+1234567890" value={settings.whatsappPhone} onChange={(e) => set('whatsappPhone', e.target.value)} style={{ width: '100%' }} />
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={save} disabled={saving || uploading || (creating && !botNameInput.trim())}>
            {saving ? 'Guardando...' : creating ? '🚀 Crear y configurar' : '💾 Guardar cambios'}
          </button>
          {!creating && (
            <button className="btn btn-secondary" onClick={reset} disabled={saving || uploading}>
              ↺ Restablecer
            </button>
          )}
          {msg && <span className="settings-status">{msg}</span>}
        </div>
      </div>

      {/* Modal: confirmar eliminación de archivo */}
      {deletingSource && (
        <div className="modal-overlay" style={{ zIndex: 200 }} onClick={() => setDeletingSource(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🗑️ Eliminar archivo</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setDeletingSource(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--gray-200)', marginBottom: 10 }}>
                ¿Seguro que quieres eliminar{' '}
                <strong style={{ color: 'var(--gold-light)' }}>
                  {sources.find((s) => s.id === deletingSource)?.title ||
                   sources.find((s) => s.id === deletingSource)?.original_filename ||
                   'este archivo'}
                </strong>
                ?
              </p>
              <p style={{ fontSize: 12, color: 'var(--gray-200)' }}>
                Se borrará el archivo, sus fragmentos, embeddings y el registro de ingesta.
                Esta acción no se puede deshacer.
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-primary"
                style={{ background: 'var(--coral)' }}
                onClick={confirmDeleteSource}
              >
                Eliminar
              </button>
              <button className="btn btn-secondary" onClick={() => setDeletingSource(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirmación de cambios sin guardar ── */}
      {confirmClose && (
        <div className="modal-overlay" onClick={() => setConfirmClose(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>💾 Cambios sin guardar</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirmClose(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--gray-200)' }}>
                Tienes cambios sin guardar en la configuración del bot. ¿Qué deseas hacer?
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={confirmSaveAndClose} disabled={saving}>
                💾 Guardar cambios
              </button>
              <button className="btn btn-secondary" onClick={confirmDiscard}>Descartar</button>
              <button className="btn btn-secondary" onClick={() => setConfirmClose(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Info Icon ─────────────────────────── */
function InfoTip({ text }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const iconRef = useRef(null);

  const handleShow = () => {
    if (iconRef.current) {
      const r = iconRef.current.getBoundingClientRect();
      setPos({ top: r.top - 8, left: r.left + r.width / 2 });
    }
    setShow(true);
  };

  return (
    <span className="info-tip" ref={iconRef}
      onMouseEnter={handleShow}
      onMouseLeave={() => setShow(false)}
      onClick={() => setShow((s) => !s)}
    >
      <span className="info-icon">ℹ️</span>
      {show && ReactDOM.createPortal(
        <span className="info-popup" style={{ top: pos.top, left: pos.left }}>
          {text}
        </span>,
        document.body
      )}
    </span>
  );
}

/* ─── Slider Row ────────────────────────── */
function Header({ status, error, checking, onRetry, onMenuToggle, botName }) {
  const label =
    status === true ? '✅ API conectada' :
    status === false ? '🔴 ' + (error || 'API desconectada') :
    '⏳ Verificando conexión...';
  const cls = status === true ? 'online' : status === false ? 'offline' : '';

  return (
    <div className="header">
      <h1>🚢 {botName || 'Plataforma'} — Knowledge Chat</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        {cls && <span className={`status-dot ${cls}${checking ? ' pulse' : ''}`} />}
        <span style={{ color: 'var(--gray-200)' }}>{label}</span>
        {status !== true && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onRetry}
            disabled={checking}
            title="Reintentar conexión"
          >
            {checking ? '⏳' : '↻ Retry'}
          </button>
        )}
        <button className="hamburger" onClick={onMenuToggle} aria-label="Menú">
          ☰
        </button>
      </div>
    </div>
  );
}

/* ─── Global Settings Modal ─────────────── */
function GlobalSettingsModal({ open, onClose }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!open) return;
    setMsg('');
    setLoading(true);
    getSettings()
      .then((s) => setPrompt(s.systemPrompt || ''))
      .catch((e) => setMsg('❌ ' + e.message))
      .finally(() => setLoading(false));
  }, [open]);

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      await updateSettings({ systemPrompt: prompt });
      setMsg('✅ Prompt global actualizado');
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={saving ? undefined : onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⚙️ Configuración General</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={saving}>✕</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <p className="settings-hint">Cargando...</p>
          ) : (
            <div className="settings-section">
              <h3>🧠 Prompt general del sistema</h3>
              <p className="settings-hint">
                Este prompt se usa como base para todos los bots que no tengan uno propio.
              </p>
              <textarea
                className="bot-name-input"
                rows={12}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Escribe el prompt general para todos los bots..."
                style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5 }}
              />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={save} disabled={saving || loading}>
            {saving ? 'Guardando...' : '💾 Guardar'}
          </button>
          {msg && <span className="settings-status">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

/* ─── App ─────────────────────────────── */
export default function App() {
  const [online, setOnline] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bots, setBots] = useState([]);
  const [selectedBotId, setSelectedBotId] = useState(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [deletingBot, setDeletingBot] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [sourcesVersion, setSourcesVersion] = useState(0);

  const loadBots = useCallback(async () => {
    try { setBots(await getBots()); } catch {}
  }, []);

  useEffect(() => { loadBots(); }, [loadBots]);

  // Auto-select first bot on initial load
  useEffect(() => {
    if (bots.length > 0 && !selectedBotId && !creatingBot) {
      setSelectedBotId(bots[0].id);
    }
  }, [bots]);

  // When current selection is no longer in the list (e.g., after delete)
  useEffect(() => {
    if (bots.length === 0 || creatingBot) return;
    if (!selectedBotId || !bots.some((b) => b.id === selectedBotId)) {
      setSelectedBotId(bots[0].id);
    }
  }, [bots, selectedBotId, creatingBot]);

  // Health check + retry
  const retryConnection = useCallback(async () => {
    setChecking(true);
    setError('');
    const result = await healthCheck();
    setOnline(result.ok);
    setError(result.ok ? '' : result.status ? `Error ${result.status}` : 'Sin conexión');
    setChecking(false);
    return result.ok;
  }, []);

  useEffect(() => {
    retryConnection();
  }, [retryConnection]);

  // Auto-retry cada 20s mientras el servidor esté offline (ej. Render free despertando)
  useEffect(() => {
    if (online !== false) return;
    const t = setInterval(() => retryConnection(), 20000);
    return () => clearInterval(t);
  }, [online, retryConnection]);

  const selectedBot = bots.find((b) => b.id === selectedBotId);
  const confirmDelete = async () => {
    if (!deletingBot || deleteConfirm.trim() !== deletingBot.name) return;
    const id = deletingBot.id;
    try {
      await deleteBot(id);
      setBots((prev) => prev.filter((b) => b.id !== id));
      if (selectedBotId === id) setSelectedBotId(null);
    } catch (e) { alert('Error: ' + e.message); }
    setDeletingBot(null);
    setDeleteConfirm('');
  };

  const handleDeleteBot = async (id) => {
    const bot = bots.find((b) => b.id === id);
    if (!bot) return;
    setDeletingBot(bot);
    setDeleteConfirm('');
  };

  return (
    <div className="layout">
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <button className="sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Cerrar menú">✕</button>

        <div className="sidebar-section">
          <h3>🤖 Mis Bots</h3>
        </div>

        <div className="bot-list">
          {bots.map((bot) => (
            <div
              key={bot.id}
              className={`bot-card${selectedBotId === bot.id ? ' selected' : ''}`}
              onClick={() => { setSelectedBotId(bot.id); setSidebarOpen(false); }}
            >
              <div className="bot-name">{bot.name}</div>
              <div className="bot-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  title="Configuración"
                  onClick={(e) => { e.stopPropagation(); setSelectedBotId(bot.id); setSettingsOpen(true); }}
                >⚙️</button>
                <button
                  className="btn btn-secondary btn-sm"
                  title="Eliminar"
                  onClick={(e) => { e.stopPropagation(); handleDeleteBot(bot.id); }}
                >🗑️</button>
              </div>
            </div>
          ))}
          {bots.length === 0 && (
            <p className="settings-hint" style={{ padding: '0 16px' }}>No hay bots aún. Crea uno para empezar.</p>
          )}
        </div>

        <div className="sidebar-section">
          <button
            className="btn btn-primary btn-block"
            onClick={() => {
              setSelectedBotId(null);
              setCreatingBot(true);
              setSettingsOpen(true);
            }}
          >
            + Nuevo Bot
          </button>
        </div>

        <div className="sidebar-section">
          <button
            className="btn btn-secondary btn-block"
            onClick={() => setGlobalSettingsOpen(true)}
          >
            ⚙️ Configuración General
          </button>
        </div>
      </aside>

      <main className="main">
        <Header
          status={online}
          error={error}
          checking={checking}
          onRetry={retryConnection}
          onMenuToggle={() => setSidebarOpen((o) => !o)}
          botName={selectedBot?.name}
        />
        <ChatPanel
          online={online === true}
          botId={selectedBotId}
          botName={selectedBot?.name}
          checking={checking}
          onRetry={retryConnection}
          error={error}
          hasBots={bots.length > 0}
        />
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        botId={selectedBotId}
        botName={selectedBot?.name || ''}
        creating={creatingBot}
        onCreated={(bot) => {
          setBots((prev) => [...prev, bot]);
          setSelectedBotId(bot.id);
          setCreatingBot(false);
        }}
        onBotUpdated={loadBots}
      />

      {/* Modal: eliminar bot */}
      {deletingBot && (
        <div className="modal-overlay" onClick={() => { setDeletingBot(null); setDeleteConfirm(''); }}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🗑️ Eliminar bot</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => { setDeletingBot(null); setDeleteConfirm(''); }}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--gray-200)', marginBottom: 10 }}>
                Esta acción no se puede deshacer. Escribe <strong style={{ color: 'var(--coral)' }}>{deletingBot.name}</strong> para confirmar:
              </p>
              <input
                type="text"
                className="bot-name-input"
                placeholder={deletingBot.name}
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmDelete()}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-primary"
                style={{ background: 'var(--coral)' }}
                onClick={confirmDelete}
                disabled={deleteConfirm.trim() !== deletingBot.name}
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      <GlobalSettingsModal
        open={globalSettingsOpen}
        onClose={() => setGlobalSettingsOpen(false)}
      />
    </div>
  );
}
