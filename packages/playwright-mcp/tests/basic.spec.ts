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

import fs from 'fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test, expect } from './fixtures';

test('test tool list', async ({ client, visionClient }) => {
  const { tools } = await client.listTools();
  expect(tools.map(t => t.name)).toEqual([
    'browser_navigate',
    'browser_go_back',
    'browser_go_forward',
    'browser_choose_file',
    'browser_snapshot',
    'browser_click',
    'browser_hover',
    'browser_type',
    'browser_select_option',
    'browser_take_screenshot',
    'browser_press_key',
    'browser_wait',
    'browser_save_as_pdf',
    'browser_close',
    'browser_install',
  ]);

  const { tools: visionTools } = await visionClient.listTools();
  expect(visionTools.map(t => t.name)).toEqual([
    'browser_navigate',
    'browser_go_back',
    'browser_go_forward',
    'browser_choose_file',
    'browser_screenshot',
    'browser_move_mouse',
    'browser_click',
    'browser_drag',
    'browser_type',
    'browser_press_key',
    'browser_wait',
    'browser_save_as_pdf',
    'browser_close',
    'browser_install',
  ]);
});

test('test resources list', async ({ client }) => {
  const { resources } = await client.listResources();
  expect(resources).toEqual([
    expect.objectContaining({
      uri: 'browser://console',
      mimeType: 'text/plain',
    }),
  ]);
});

test('test browser_navigate', async ({ client }) => {
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><body>Hello, world!</body></html>',
    },
  })).toHaveTextContent(`
- Page URL: data:text/html,<html><title>Title</title><body>Hello, world!</body></html>
- Page Title: Title
- Page Snapshot
\`\`\`yaml
- text: Hello, world!
\`\`\`
`
  );
});

test('test browser_click', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><button>Submit</button></html>',
    },
  });

  expect(await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Submit button',
      ref: 's1e3',
    },
  })).toHaveTextContent(`"Submit button" clicked

- Page URL: data:text/html,<html><title>Title</title><button>Submit</button></html>
- Page Title: Title
- Page Snapshot
\`\`\`yaml
- button "Submit" [ref=s2e3]
\`\`\`
`);
});

test('test reopen browser', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><body>Hello, world!</body></html>',
    },
  });

  expect(await client.callTool({
    name: 'browser_close',
  })).toHaveTextContent('Page closed');

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><body>Hello, world!</body></html>',
    },
  })).toHaveTextContent(`
- Page URL: data:text/html,<html><title>Title</title><body>Hello, world!</body></html>
- Page Title: Title
- Page Snapshot
\`\`\`yaml
- text: Hello, world!
\`\`\`
`);
});

test('single option', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><select><option value="foo">Foo</option><option value="bar">Bar</option></select></html>',
    },
  });

  expect(await client.callTool({
    name: 'browser_select_option',
    arguments: {
      element: 'Select',
      ref: 's1e3',
      values: ['bar'],
    },
  })).toHaveTextContent(`Selected option in "Select"

- Page URL: data:text/html,<html><title>Title</title><select><option value="foo">Foo</option><option value="bar">Bar</option></select></html>
- Page Title: Title
- Page Snapshot
\`\`\`yaml
- combobox [ref=s2e3]:
    - option "Foo" [ref=s2e4]
    - option "Bar" [selected] [ref=s2e5]
\`\`\`
`);
});

test('multiple option', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><select multiple><option value="foo">Foo</option><option value="bar">Bar</option><option value="baz">Baz</option></select></html>',
    },
  });

  expect(await client.callTool({
    name: 'browser_select_option',
    arguments: {
      element: 'Select',
      ref: 's1e3',
      values: ['bar', 'baz'],
    },
  })).toHaveTextContent(`Selected option in "Select"

- Page URL: data:text/html,<html><title>Title</title><select multiple><option value="foo">Foo</option><option value="bar">Bar</option><option value="baz">Baz</option></select></html>
- Page Title: Title
- Page Snapshot
\`\`\`yaml
- listbox [ref=s2e3]:
    - option "Foo" [ref=s2e4]
    - option "Bar" [selected] [ref=s2e5]
    - option "Baz" [selected] [ref=s2e6]
\`\`\`
`);
});

test('browser://console', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><script>console.log("Hello, world!");console.error("Error"); </script></html>',
    },
  });

  const resource = await client.readResource({
    uri: 'browser://console',
  });
  expect(resource.contents).toEqual([{
    uri: 'browser://console',
    mimeType: 'text/plain',
    text: '[LOG] Hello, world!\n[ERROR] Error',
  }]);
});

test('stitched aria frames', async ({ client }) => {
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: `data:text/html,<h1>Hello</h1><iframe src="data:text/html,<button>World</button><main><iframe src='data:text/html,<p>Nested</p>'></iframe></main>"></iframe><iframe src="data:text/html,<h1>Should be invisible</h1>" style="display: none;"></iframe>`,
    },
  })).toContainTextContent(`
\`\`\`yaml
- heading "Hello" [level=1] [ref=s1e3]
- iframe [ref=s1e4]:
    - button "World" [ref=f1s1e3]
    - main [ref=f1s1e4]:
        - iframe [ref=f1s1e5]:
            - paragraph [ref=f2s1e3]: Nested
\`\`\`
`);

  expect(await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'World',
      ref: 'f1s1e3',
    },
  })).toContainTextContent('"World" clicked');
});

test('browser_choose_file', async ({ client }) => {
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><input type="file" /><button>Button</button></html>',
    },
  })).toContainTextContent('- textbox [ref=s1e3]');

  expect(await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Textbox',
      ref: 's1e3',
    },
  })).toContainTextContent('There is a file chooser visible that requires browser_choose_file to be called');

  const filePath = test.info().outputPath('test.txt');
  await fs.writeFile(filePath, 'Hello, world!');

  {
    const response = await client.callTool({
      name: 'browser_choose_file',
      arguments: {
        paths: [filePath],
      },
    });

    expect(response).not.toContainTextContent('There is a file chooser visible that requires browser_choose_file to be called');
    expect(response).toContainTextContent('textbox [ref=s3e3]: C:\\fakepath\\test.txt');
  }

  {
    const response = await client.callTool({
      name: 'browser_click',
      arguments: {
        element: 'Textbox',
        ref: 's3e3',
      },
    });

    expect(response).toContainTextContent('There is a file chooser visible that requires browser_choose_file to be called');
    expect(response).toContainTextContent('button "Button" [ref=s4e4]');
  }

  {
    const response = await client.callTool({
      name: 'browser_click',
      arguments: {
        element: 'Button',
        ref: 's4e4',
      },
    });

    expect(response, 'not submitting browser_choose_file dismisses file chooser').not.toContainTextContent('There is a file chooser visible that requires browser_choose_file to be called');
  }
});

test('sse transport', async () => {
  const cp = spawn('node', [path.join(__dirname, '../cli.js'), '--port', '0'], { stdio: 'pipe' });
  try {
    let stdout = '';
    const url = await new Promise<string>(resolve => cp.stdout?.on('data', data => {
      stdout += data.toString();
      const match = stdout.match(/Listening on (http:\/\/.*)/);
      if (match)
        resolve(match[1]);
    }));

    // need dynamic import b/c of some ESM nonsense
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const transport = new SSEClientTransport(new URL(url));
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    await client.ping();
  } finally {
    cp.kill();
  }
});

test('cdp server', async ({ cdpEndpoint, startClient }) => {
  const client = await startClient({ args: [`--cdp-endpoint=${cdpEndpoint}`] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><body>Hello, world!</body></html>',
    },
  })).toHaveTextContent(`
- Page URL: data:text/html,<html><title>Title</title><body>Hello, world!</body></html>
- Page Title: Title
- Page Snapshot
\`\`\`yaml
- text: Hello, world!
\`\`\`
`
  );
});

test('save as pdf', async ({ client }) => {
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><body>Hello, world!</body></html>',
    },
  })).toHaveTextContent(`
- Page URL: data:text/html,<html><title>Title</title><body>Hello, world!</body></html>
- Page Title: Title
- Page Snapshot
\`\`\`yaml
- text: Hello, world!
\`\`\`
`
  );

  const response = await client.callTool({
    name: 'browser_save_as_pdf',
  });
  expect(response).toHaveTextContent(/^Saved as.*page-[^:]+.pdf$/);
});

test('executable path', async ({ startClient }) => {
  const client = await startClient({ args: [`--executable-path=bogus`] });
  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>Title</title><body>Hello, world!</body></html>',
    },
  });
  expect(response).toContainTextContent(`executable doesn't exist`);
});

test('browser_take_html_snippet - whole page', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>HTML Test</title><body><div id="test">Hello, world!</div></body></html>',
    },
  });

  const result = await client.callTool({
    name: 'browser_take_html_snippet',
    arguments: {},
  });
  
  const content = result.content as Array<{type: string, text: string}>;
  expect(content[0].text).toContain('```html');
  expect(content[0].text).toContain('<html>');
  expect(content[0].text).toContain('<title>');
  expect(content[0].text).toContain('HTML Test');
  expect(content[0].text).toContain('<div id="test">');
  expect(content[0].text).toContain('Hello, world!');
  // Check for formatting markers like indentation and line breaks
  expect(content[0].text).toContain('\n');
  expect(content[0].text.split('\n').length).toBeGreaterThan(5); // Multiple lines indicating formatting
});

test('browser_take_html_snippet - specific element', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><title>HTML Test</title><body><div id="test">Hello, world!</div></body></html>',
    },
  });
  
  // First get a snapshot to get the element ref
  const snapshot = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });
  
  // Extract the ref from the snapshot
  const snapshotContent = snapshot.content as Array<{type: string, text: string}>;
  const match = snapshotContent[0].text.match(/div.*?\[ref=(s\d+e\d+)\]/);
  const ref = match ? match[1] : null;
  
  expect(ref).toBeTruthy();
  
  // Get the inner HTML of the div
  const innerResult = await client.callTool({
    name: 'browser_take_html_snippet',
    arguments: {
      element: 'div element',
      ref,
      includeOuter: false,
    },
  });
  
  const innerContent = innerResult.content as Array<{type: string, text: string}>;
  expect(innerContent[0].text).toBe('Hello, world!');
  
  // Get the outer HTML of the div
  const outerResult = await client.callTool({
    name: 'browser_take_html_snippet',
    arguments: {
      element: 'div element',
      ref,
      includeOuter: true,
    },
  });
  
  const outerContent = outerResult.content as Array<{type: string, text: string}>;
  expect(outerContent[0].text).toBe('<div id="test">Hello, world!</div>');
});

test('browser_take_html_snippet - tag filtering', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<html><head><meta name="test"><style>body{color:red;}</style><script>console.log("test");</script><link rel="stylesheet" href="#"></head><title>Filter Test</title><body><div id="test">Content</div></body></html>',
    },
  });

  // Test with default filtering (meta, script, style, link)
  const defaultResult = await client.callTool({
    name: 'browser_take_html_snippet',
    arguments: {},
  });
  
  const defaultContent = defaultResult.content as Array<{type: string, text: string}>;
  expect(defaultContent[0].text).toContain('```html');
  expect(defaultContent[0].text).toContain('<title>Filter Test</title>');
  expect(defaultContent[0].text).toContain('<div id="test">');
  expect(defaultContent[0].text).toContain('Content');
  expect(defaultContent[0].text).not.toContain('<meta name="test">');
  expect(defaultContent[0].text).not.toContain('<style>');
  expect(defaultContent[0].text).not.toContain('<script>');
  expect(defaultContent[0].text).not.toContain('<link');
  // Check for formatting markers
  expect(defaultContent[0].text).toContain('\n');
  expect(defaultContent[0].text.split('\n').length).toBeGreaterThan(5);
  
  // Test with custom filtering (only title)
  const customResult = await client.callTool({
    name: 'browser_take_html_snippet',
    arguments: {
      filterTags: ['title'],
    },
  });
  
  const customContent = customResult.content as Array<{type: string, text: string}>;
  expect(customContent[0].text).not.toContain('<title>');
  expect(customContent[0].text).toContain('<meta name="test">');
  expect(customContent[0].text).toContain('<style>');
  expect(customContent[0].text).toContain('<script>');
  expect(customContent[0].text).toContain('<div id="test">Content</div>');
});
