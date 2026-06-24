import { initializeApp, getApp, getApps } from 'firebase/app';

const firebaseConfig = {
  apiKey: 'AIzaSyCQYeKWSOpAETyOD9pmaIgKyoRV9KAmP-g',
  authDomain: 'chat-action-gateway.firebaseapp.com',
  projectId: 'chat-action-gateway',
  storageBucket: 'chat-action-gateway.firebasestorage.app',
  messagingSenderId: '928975117396',
  appId: '1:928975117396:web:9eace654a611640a50e1c1',
  measurementId: 'G-7QQ7SZPJHT'
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export { app };
