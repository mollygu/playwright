/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './inspectorTest';
import http from 'http';

const emptyHTML = 'data:text/html,<!DOCTYPE html><html><head></head><body></body></html>';

test('should connect to an existing CDP endpoint', async ({ browserName, runCLI, browserType, headless }) => {
  test.skip(browserName !== 'chromium', 'CDP connection is only supported in Chromium');
  test.skip(headless, 'CDP connection test requires a non-headless browser');

  // Start a browser with remote debugging
  const port = 9339;
  const browserServer = await browserType.launch({
    args: ['--remote-debugging-port=' + port]
  });

  try {
    // Get the CDP endpoint URL
    const json = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/json/version/`, resp => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve(data));
      }).on('error', reject);
    });
    const webSocketDebuggerUrl = JSON.parse(json).webSocketDebuggerUrl;

    // Run codegen with CDP endpoint
    const cli = runCLI(['--cdp-endpoint=' + webSocketDebuggerUrl, emptyHTML]);
    const expectedResult = 'page.goto';
    await cli.waitFor(expectedResult);

    // Close CLI
    await cli.process.kill('SIGINT');
  } finally {
    await browserServer.close();
  }
}); 