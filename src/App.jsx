import { CheckCircle2 } from 'lucide-react';
import OAuthLogin from './pages/OAuthLogin.jsx';

const App = () => {
  if (window.location.pathname === '/oauth-login') {
    return <OAuthLogin />;
  }

  return (
    <main className="page page-success">
      <section className="result-panel" aria-live="polite">
        <div className="status-mark">
          <CheckCircle2 size={34} strokeWidth={2.2} />
        </div>

        <div className="result-copy">
          <p className="eyebrow">Chat Action Gateway</p>
          <h1>Servidor listo</h1>
          <p>El MCP y la API estan disponibles desde esta misma Function.</p>
        </div>
      </section>
    </main>
  );
};

export default App;
