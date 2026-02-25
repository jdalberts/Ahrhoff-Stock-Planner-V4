import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import {
  fetchShippingSnapshot,
  fetchVesselPosition,
  fetchVesselVoyage,
} from './server/marinetrafficService';

const json = (res: any, code: number, payload: unknown) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const parseImo = (url: string): string => {
  const parsed = new URL(url, 'http://localhost');
  return (parsed.searchParams.get('imo') || '').trim();
};

const parseContainerNumber = (url: string): string => {
  const parsed = new URL(url, 'http://localhost');
  return (parsed.searchParams.get('containerNumber') || '').trim();
};

const shippingProxyPlugin = (apiKey?: string) => ({
  name: 'shipping-proxy-plugin',
  configureServer(server: any) {
    server.middlewares.use('/api/shipping', async (req: any, res: any) => {
      if (!apiKey) {
        json(res, 500, { error: 'MARINETRAFFIC_API_KEY is not configured' });
        return;
      }

      const lookup = {
        imo: parseImo(req.url || ''),
        containerNumber: parseContainerNumber(req.url || ''),
      };
      if (!lookup.imo && !lookup.containerNumber) {
        json(res, 400, { error: 'Query parameter "imo" or "containerNumber" is required' });
        return;
      }

      try {
        if (req.url?.startsWith('/vessel-voyage')) {
          const data = await fetchVesselVoyage(lookup, apiKey);
          json(res, 200, data);
          return;
        }

        if (req.url?.startsWith('/vessel-position')) {
          const data = await fetchVesselPosition(lookup, apiKey);
          json(res, 200, data);
          return;
        }

        if (req.url?.startsWith('/snapshot')) {
          const data = await fetchShippingSnapshot(lookup, apiKey);
          json(res, 200, data);
          return;
        }

        json(res, 404, { error: 'Route not found' });
      } catch (error: any) {
        json(res, 502, {
          error: 'Unable to fetch shipping data',
          detail: error?.message || 'Upstream request failed',
        });
      }
    });
  },
  configurePreviewServer(server: any) {
    server.middlewares.use('/api/shipping', async (req: any, res: any) => {
      if (!apiKey) {
        json(res, 500, { error: 'MARINETRAFFIC_API_KEY is not configured' });
        return;
      }

      const lookup = {
        imo: parseImo(req.url || ''),
        containerNumber: parseContainerNumber(req.url || ''),
      };
      if (!lookup.imo && !lookup.containerNumber) {
        json(res, 400, { error: 'Query parameter "imo" or "containerNumber" is required' });
        return;
      }

      try {
        if (req.url?.startsWith('/vessel-voyage')) {
          const data = await fetchVesselVoyage(lookup, apiKey);
          json(res, 200, data);
          return;
        }

        if (req.url?.startsWith('/vessel-position')) {
          const data = await fetchVesselPosition(lookup, apiKey);
          json(res, 200, data);
          return;
        }

        if (req.url?.startsWith('/snapshot')) {
          const data = await fetchShippingSnapshot(lookup, apiKey);
          json(res, 200, data);
          return;
        }

        json(res, 404, { error: 'Route not found' });
      } catch (error: any) {
        json(res, 502, {
          error: 'Unable to fetch shipping data',
          detail: error?.message || 'Upstream request failed',
        });
      }
    });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const marineTrafficApiKey = env.MARINETRAFFIC_API_KEY || process.env.MARINETRAFFIC_API_KEY;

  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react(), shippingProxyPlugin(marineTrafficApiKey)],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './'),
      }
    }
  };
});
