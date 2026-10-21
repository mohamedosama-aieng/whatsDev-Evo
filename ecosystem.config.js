// pm2 process definitions for the dk.whatsdeveloper.com stack (F:\whatsDev-Evo).
//
// Names are prefixed "dkevo-" on purpose. The separate project at F:\WhatsDeveloper
// used the names "WhatsDeveloper-Back" / "WhatsDeveloper-Front", which was confusing
// enough to cause an incident. Do not reuse those names here.
//
// The frontend is NOT listed: it is a static build in
// WhatsDeveloper-Manager/dist served directly by IIS. There is no Node process
// for it, which is what removed the ECONNRESET crash class.

module.exports = {
  apps: [
    {
      // Express bridge: Evolution <-> n8n. Listens on 55453 (PORT in .env).
      name: 'dkevo-backend',
      script: 'dist/index.js',
      cwd: 'F:/whatsDev-Evo/whatsdeveloper-backend',
      // Requires `npm run build` first; dist/index.js is the compiled output.
      watch: false,
      autorestart: true,
      max_memory_restart: '512M',
      restart_delay: 5000,
      min_uptime: '10s',
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      // Evolution API. Listens on 2345 (SERVER_PORT in its .env).
      // Invoke node.exe as the binary. PM2 cannot spawn the tsx .cmd shim on
      // Windows, while this is the same command used by `npm start`.
      name: 'dkevo-evolution',
      script: 'C:/Program Files/nodejs/node.exe',
      args: '--env-file=.env ./node_modules/tsx/dist/cli.mjs ./src/main.ts',
      cwd: 'F:/whatsDev-Evo/evolution-api',
      interpreter: 'none',
      watch: false,
      autorestart: true,
      // Baileys holds WhatsApp sockets and media buffers; give it more room.
      max_memory_restart: '1G',
      restart_delay: 5000,
      min_uptime: '30s',
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
