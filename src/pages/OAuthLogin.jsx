import { AlertCircle, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect
} from 'firebase/auth';
import { app } from '../firebase';

const AUTHORIZE_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'resource'
];

const OAUTH_PARAMS_KEY = 'chat-action-gateway-oauth-params';
const OAUTH_PENDING_KEY = 'chat-action-gateway-oauth-pending';

const getAuthorizeParamsFromUrl = () => {
  const searchParams = new URLSearchParams(window.location.search);

  return AUTHORIZE_FIELDS.reduce((params, field) => {
    const value = searchParams.get(field);

    if (value) {
      params[field] = value;
    }

    return params;
  }, {});
};

const getStoredAuthorizeParams = () => {
  try {
    return JSON.parse(sessionStorage.getItem(OAUTH_PARAMS_KEY) || '{}');
  } catch (error) {
    return {};
  }
};

const getErrorMessage = () => {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('error') || '';
};

const hasUsableParams = (params) => Boolean(
  params.response_type
  && params.client_id
  && params.redirect_uri
  && params.resource
);

const shouldFallbackToRedirect = (loginError) => [
  'auth/popup-blocked',
  'auth/cancelled-popup-request',
  'auth/operation-not-supported-in-this-environment'
].includes(loginError?.code);

const OAuthLogin = () => {
  const auth = useMemo(() => getAuth(app), []);
  const formRef = useRef(null);
  const tokenInputRef = useRef(null);
  const submittedRef = useRef(false);
  const initialError = useMemo(() => getErrorMessage(), []);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(initialError);
  const [isBusy, setIsBusy] = useState(false);

  const authorizeParams = useMemo(() => {
    const paramsFromUrl = getAuthorizeParamsFromUrl();

    if (hasUsableParams(paramsFromUrl)) {
      sessionStorage.setItem(OAUTH_PARAMS_KEY, JSON.stringify(paramsFromUrl));
      return paramsFromUrl;
    }

    return getStoredAuthorizeParams();
  }, []);

  const submitWithUser = useCallback(async (user) => {
    if (!user || submittedRef.current) {
      return;
    }

    submittedRef.current = true;
    setIsBusy(true);
    setError('');
    setStatus('Terminando conexion...');
    tokenInputRef.current.value = await user.getIdToken(true);
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    formRef.current.submit();
  }, []);

  useEffect(() => {
    let isMounted = true;

    if (initialError) {
      sessionStorage.removeItem(OAUTH_PENDING_KEY);
      return () => {
        isMounted = false;
      };
    }

    getRedirectResult(auth)
      .then(async (result) => {
        if (isMounted && result?.user) {
          await submitWithUser(result.user);
        }
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }

        sessionStorage.removeItem(OAUTH_PENDING_KEY);
        setIsBusy(false);
        setError('Google no completo el inicio de sesion. Intenta de nuevo.');
      });

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (
        isMounted
        && user
        && (
          sessionStorage.getItem(OAUTH_PENDING_KEY) === '1'
          || hasUsableParams(authorizeParams)
        )
      ) {
        await submitWithUser(user);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [auth, authorizeParams, initialError, submitWithUser]);

  const handleGoogleLogin = async () => {
    if (!hasUsableParams(authorizeParams)) {
      setError('Faltan datos de autorizacion para conectar ChatGPT.');
      return;
    }

    try {
      setIsBusy(true);
      setError('');
      setStatus('Abriendo Google...');
      sessionStorage.setItem(OAUTH_PENDING_KEY, '1');

      if (auth.currentUser) {
        await submitWithUser(auth.currentUser);
        return;
      }

      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });

      try {
        const result = await signInWithPopup(auth, provider);

        if (result?.user) {
          await submitWithUser(result.user);
          return;
        }
      } catch (popupError) {
        if (!shouldFallbackToRedirect(popupError)) {
          throw popupError;
        }
      }

      await signInWithRedirect(auth, provider);
    } catch (loginError) {
      submittedRef.current = false;
      sessionStorage.removeItem(OAUTH_PENDING_KEY);
      setIsBusy(false);
      setError('No se pudo iniciar sesion con Google. Intenta de nuevo.');
    }
  };

  return (
    <main className={`page ${error ? 'page-error' : 'page-loading'}`}>
      <section className="result-panel oauth-panel" aria-live="polite">
        <div className="status-mark">
          {error ? (
            <AlertCircle size={34} strokeWidth={2.2} />
          ) : (
            <Loader2 size={34} strokeWidth={2.2} className={isBusy ? 'spin' : ''} />
          )}
        </div>

        <div className="result-copy">
          <p className="eyebrow">Chat Action Gateway</p>
          <h1>Conectar ChatGPT</h1>
          <p>Inicia sesion con Google para vincular este conector con tu cuenta de gastos.</p>
        </div>

        {error && (
          <div className="inline-error">
            {error}
          </div>
        )}

        <form ref={formRef} method="post" action="/oauth/authorize" className="oauth-form">
          {Object.entries(authorizeParams).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} readOnly />
          ))}
          <input ref={tokenInputRef} type="hidden" name="firebaseIdToken" />
          <button
            type="button"
            className="oauth-button"
            disabled={isBusy}
            onClick={handleGoogleLogin}
          >
            <span className="google-letter" aria-hidden="true">G</span>
            Continuar con Google
          </button>
        </form>

        {status && (
          <p className="oauth-status">
            {status}
          </p>
        )}
      </section>
    </main>
  );
};

export default OAuthLogin;
