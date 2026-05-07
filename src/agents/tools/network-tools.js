import { promises as fs } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { TOOL_CATEGORIES } from '../universal-toolbox.js';

function httpRequest(toolbox, method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'User-Agent': 'NexusCodeForge-UniversalToolbox/1.0',
        ...headers,
      },
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          status_code: res.statusCode,
          headers: res.headers,
          body: data.substring(0, toolbox.config.max_output_size),
        });
      });
    });

    req.on('error', (err) => resolve({ error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function httpDownload(toolbox, url, destPath) {
  return toolbox.execute('http_download', {
    url,
    dest: path.relative(toolbox.config.workspace_root, destPath),
  });
}

export function registerNetworkTools(toolbox) {
  toolbox._registerTool(
    'http_get',
    TOOL_CATEGORIES.NETWORK,
    '发送 GET 请求',
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        headers: { type: 'object' },
      },
      required: ['url'],
    },
    async (args) => {
      return httpRequest(toolbox, 'GET', args.url, null, args.headers);
    },
  );

  toolbox._registerTool(
    'http_post',
    TOOL_CATEGORIES.NETWORK,
    '发送 POST 请求',
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        body: { type: 'string' },
        headers: { type: 'object' },
      },
      required: ['url', 'body'],
    },
    async (args) => {
      return httpRequest(toolbox, 'POST', args.url, args.body, args.headers);
    },
  );

  toolbox._registerTool(
    'http_fetch_json',
    TOOL_CATEGORIES.NETWORK,
    '获取并解析 JSON',
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        headers: { type: 'object' },
      },
      required: ['url'],
    },
    async (args) => {
      const result = await httpRequest(toolbox, 'GET', args.url, null, args.headers);
      try {
        result.json = JSON.parse(result.body);
        return result;
      } catch {
        return { ...result, json: null, parse_error: 'Failed to parse JSON' };
      }
    },
  );

  toolbox._registerTool(
    'http_download',
    TOOL_CATEGORIES.NETWORK,
    '下载文件',
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        dest: { type: 'string' },
      },
      required: ['url', 'dest'],
    },
    async (args) => {
      const destPath = toolbox._resolvePathInWorkspace(args.dest, 'dest');
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const file = await fs.open(destPath, 'w');

      return new Promise((resolve) => {
        const urlObj = new URL(args.url);
        const client = urlObj.protocol === 'https:' ? https : http;

        client
          .get(args.url, (response) => {
            if (
              response.statusCode >= 300 &&
              response.statusCode < 400 &&
              response.headers.location
            ) {
              httpDownload(toolbox, response.headers.location, destPath).then(resolve);
              return;
            }

            response.pipe(file);
            response.on('end', () => {
              file.close();
              resolve({ url: args.url, dest: args.dest, downloaded: true });
            });
          })
          .on('error', async (err) => {
            await file.close();
            resolve({ url: args.url, dest: args.dest, error: err.message });
          });
      });
    },
  );
}
