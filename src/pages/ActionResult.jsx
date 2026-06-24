import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import api from '../middleware/api';

const statusContent = {
  loading: {
    title: 'Registrando accion',
    description: 'Estamos validando el enlace y guardando la informacion.',
    icon: Loader2
  },
  success: {
    title: 'Registro exitoso',
    description: 'La accion se completo correctamente.',
    icon: CheckCircle2
  },
  error: {
    title: 'No se pudo registrar',
    description: 'Revisa los datos del enlace o intenta generar uno nuevo.',
    icon: AlertCircle
  }
};

const getActionFromPath = () => {
  const parts = window.location.pathname.split('/').filter(Boolean);

  if (parts.length < 3 || parts[0] !== 'action') {
    return null;
  }

  return {
    method: parts[1],
    type: parts[2]
  };
};

const getQueryPayload = () => {
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(params.entries());
};

const ActionResult = () => {
  const action = useMemo(() => getActionFromPath(), []);
  const payload = useMemo(() => getQueryPayload(), []);
  const [status, setStatus] = useState('loading');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const runAction = async () => {
      if (!action) {
        setStatus('error');
        setError({
          code: 'unsupported_route',
          message: 'Esta ruta no corresponde a una accion valida.'
        });
        return;
      }

      try {
        const response = await api.post(`/action/${action.method}/${action.type}`, payload);
        setResult(response.data.data);
        setStatus('success');
      } catch (requestError) {
        const responseError = requestError.response?.data?.error;
        setError(responseError || {
          code: 'request_failed',
          message: requestError.message || 'Error inesperado.'
        });
        setStatus('error');
      }
    };

    runAction();
  }, [action, payload]);

  const currentStatus = statusContent[status];
  const StatusIcon = currentStatus.icon;

  return (
    <main className={`page page-${status}`}>
      <section className="result-panel" aria-live="polite">
        <div className="status-mark">
          <StatusIcon size={34} strokeWidth={2.2} className={status === 'loading' ? 'spin' : ''} />
        </div>

        <div className="result-copy">
          <p className="eyebrow">Agent Action Gateway</p>
          <h1>{currentStatus.title}</h1>
          <p>{error?.message || currentStatus.description}</p>
        </div>

        {result && (
          <dl className="details">
            <div>
              <dt>ID</dt>
              <dd>{result.documentId}</dd>
            </div>
            <div>
              <dt>Accion</dt>
              <dd>{result.action}</dd>
            </div>
            <div>
              <dt>Usuario</dt>
              <dd>{result.userId}</dd>
            </div>
          </dl>
        )}

        {error && (
          <dl className="details">
            <div>
              <dt>Codigo</dt>
              <dd>{error.code}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
};

export default ActionResult;
