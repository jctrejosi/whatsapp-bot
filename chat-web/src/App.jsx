import { useState, useEffect, useRef, useCallback } from 'react';
import { chat, getSources, getSource, ingestPdf, healthCheck } from './api.js';

/* ─── Message Bubble ──────────────────── */
function MessageBubble({ msg }) {
  const [showSources, setShowSources] = useState(false);

  const isUser = msg.role === 'user';

  return (
    <div className={`message ${isUser ? 'user' : 'bot'}`}>
      {!isUser && <div className="label">🤖 Quinceañera Bot</div>}
      {isUser && <div className="label">Tú</div>}
      <div className="bubble">{msg.text}</div>

      {!isUser && msg.chunks && msg.chunks.length > 0 && (
        <>
          <span className="sources-toggle" onClick={() => setShowSources(!showSources)}>
            {showSources ? '▲ Ocultar fuentes' : '▼ Ver fuentes usadas'} ({msg.chunks.length})
          </span>
          {showSources && (
            <div className="sources-list">
              {msg.chunks.map((c, i) => (
                <div key={i} className="source-item">
                  <strong>Fuente {i + 1}</strong> — fragmento {c.chunk_index}
                  <br />
                  {c.content.substring(0, 150)}...
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Typing Indicator ────────────────── */
function TypingIndicator() {
  return (
    <div className="message bot">
      <div className="label">🤖 Quinceañera Bot</div>
      <div className="bubble">
        <div className="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  );
}

/* ─── Chat Panel ──────────────────────── */
function ChatPanel({ online }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEnd = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => scrollToBottom(), [messages, loading]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading || !online) return;

    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setLoading(true);

    try {
      const data = await chat(text);
      setMessages((prev) => [
        ...prev,
        {
          role: 'bot',
          text: data.answer,
          chunks: data.chunks_used || [],
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'bot',
          text: '❌ ' + err.message,
        },
      ]);
    } finally {
      setLoading(false);
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
          <div className="message bot">
            <div className="label">🤖 Quinceañera Bot</div>
            <div className="bubble">
              ⏳ Conectando con el servicio...
            </div>
          </div>
        )}
        {online && messages.length === 0 && (
          <div className="message bot">
            <div className="label">🤖 Quinceañera Bot</div>
            <div className="bubble">
              ¡Hola! Soy el asistente del crucero de Quinceañeras a bordo del MSC World America (20-27 marzo 2027). Pregúntame lo que quieras sobre el evento.
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
        {loading && <TypingIndicator />}
        <div ref={messagesEnd} />
      </div>

      <div className="input-area">
        <input
          type="text"
          placeholder={online ? 'Escribe tu pregunta sobre el crucero...' : 'Servicio no disponible — esperando conexión...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading || !online}
        />
        <button
          className="btn btn-primary"
          onClick={handleSend}
          disabled={loading || !online || !input.trim()}
        >
          Enviar
        </button>
      </div>
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
function SourceList() {
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

  useEffect(() => {
    loadSources();
    const interval = setInterval(loadSources, 10000);
    return () => clearInterval(interval);
  }, [loadSources]);

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
      <div className="sidebar-section">
        <h3>📚 Base de conocimiento ({sources.length})</h3>
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

/* ─── Header ──────────────────────────── */
function Header({ status, error }) {
  const label =
    status === true ? '✅ API conectada' :
    status === false ? '🔴 ' + (error || 'API desconectada') :
    '⏳ Verificando conexión...';
  const cls = status === true ? 'online' : status === false ? 'offline' : '';

  return (
    <div className="header">
      <h1>🚢 Quinceañera Cruise — Knowledge Chat</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        {cls && <span className={`status-dot ${cls}`} />}
        <span style={{ color: 'var(--gray-200)' }}>{label}</span>
      </div>
    </div>
  );
}

/* ─── App ─────────────────────────────── */
export default function App() {
  const [online, setOnline] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const check = async () => {
      const result = await healthCheck();
      setOnline(result.ok);
      if (!result.ok && result.status) {
        setError(`Error ${result.status}`);
      } else if (!result.ok) {
        setError('Sin conexión');
      } else {
        setError('');
      }
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <UploadPanel onRefresh={() => {}} />
        <SourceList />
      </aside>
      <main className="main">
        <Header status={online} error={error} />
        <ChatPanel online={online === true} />
      </main>
    </div>
  );
}
