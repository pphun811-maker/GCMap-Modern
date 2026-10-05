import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../design-assets/palettes/apple-maps-tokens.css';
import './app.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
