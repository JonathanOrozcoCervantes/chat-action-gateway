import axios from 'axios';
import { initializeAppCheck, ReCaptchaV3Provider, getToken } from 'firebase/app-check';
import { app } from '../firebase';
import { API_BASE_URL, SITE_KEY_RECAPTCHA } from '../config/settings';

let appCheck = null;

if (SITE_KEY_RECAPTCHA) {
  appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(SITE_KEY_RECAPTCHA),
    isTokenAutoRefreshEnabled: true
  });
} else {
  console.warn('App Check is not initialized because SITE_KEY_RECAPTCHA is empty.');
}

const api = axios.create({
  baseURL: API_BASE_URL
});

api.interceptors.request.use(
  async (config) => {
    if (!appCheck) {
      return config;
    }

    try {
      const appCheckToken = await getToken(appCheck, false);
      config.headers['X-Firebase-AppCheck'] = appCheckToken.token;
    } catch (error) {
      console.error('Error getting App Check token:', error);
    }

    return config;
  },
  (error) => Promise.reject(error)
);

export default api;
