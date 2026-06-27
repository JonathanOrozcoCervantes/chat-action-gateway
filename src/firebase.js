import { initializeApp, getApp, getApps } from 'firebase/app';
import { FIREBASE_CONFIG } from './config/settings';

const app = !getApps().length ? initializeApp(FIREBASE_CONFIG) : getApp();

export { app };
