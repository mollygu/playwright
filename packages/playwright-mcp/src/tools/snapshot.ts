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

import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { captureAriaSnapshot, runAndWait } from './utils';

import type * as playwright from 'playwright';
import type { Tool } from './tool';

export const snapshot: Tool = {
  schema: {
    name: 'browser_snapshot',
    description: 'Capture accessibility snapshot of the current page, this is better than screenshot',
    inputSchema: zodToJsonSchema(z.object({})),
  },

  handle: async context => {
    return await captureAriaSnapshot(context);
  },
};

const elementSchema = z.object({
  element: z.string().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().describe('Exact target element reference from the page snapshot'),
});

export const click: Tool = {
  schema: {
    name: 'browser_click',
    description: 'Perform click on a web page',
    inputSchema: zodToJsonSchema(elementSchema),
  },

  handle: async (context, params) => {
    const validatedParams = elementSchema.parse(params);
    return runAndWait(context, `"${validatedParams.element}" clicked`, () => context.refLocator(validatedParams.ref).click(), true);
  },
};

const dragSchema = z.object({
  startElement: z.string().describe('Human-readable source element description used to obtain the permission to interact with the element'),
  startRef: z.string().describe('Exact source element reference from the page snapshot'),
  endElement: z.string().describe('Human-readable target element description used to obtain the permission to interact with the element'),
  endRef: z.string().describe('Exact target element reference from the page snapshot'),
});

export const drag: Tool = {
  schema: {
    name: 'browser_drag',
    description: 'Perform drag and drop between two elements',
    inputSchema: zodToJsonSchema(dragSchema),
  },

  handle: async (context, params) => {
    const validatedParams = dragSchema.parse(params);
    return runAndWait(context, `Dragged "${validatedParams.startElement}" to "${validatedParams.endElement}"`, async () => {
      const startLocator = context.refLocator(validatedParams.startRef);
      const endLocator = context.refLocator(validatedParams.endRef);
      await startLocator.dragTo(endLocator);
    }, true);
  },
};

export const hover: Tool = {
  schema: {
    name: 'browser_hover',
    description: 'Hover over element on page',
    inputSchema: zodToJsonSchema(elementSchema),
  },

  handle: async (context, params) => {
    const validatedParams = elementSchema.parse(params);
    return runAndWait(context, `Hovered over "${validatedParams.element}"`, () => context.refLocator(validatedParams.ref).hover(), true);
  },
};

const typeSchema = elementSchema.extend({
  text: z.string().describe('Text to type into the element'),
  submit: z.boolean().describe('Whether to submit entered text (press Enter after)'),
});

export const type: Tool = {
  schema: {
    name: 'browser_type',
    description: 'Type text into editable element',
    inputSchema: zodToJsonSchema(typeSchema),
  },

  handle: async (context, params) => {
    const validatedParams = typeSchema.parse(params);
    return await runAndWait(context, `Typed "${validatedParams.text}" into "${validatedParams.element}"`, async () => {
      const locator = context.refLocator(validatedParams.ref);
      await locator.fill(validatedParams.text);
      if (validatedParams.submit)
        await locator.press('Enter');
    }, true);
  },
};

const selectOptionSchema = elementSchema.extend({
  values: z.array(z.string()).describe('Array of values to select in the dropdown. This can be a single value or multiple values.'),
});

export const selectOption: Tool = {
  schema: {
    name: 'browser_select_option',
    description: 'Select an option in a dropdown',
    inputSchema: zodToJsonSchema(selectOptionSchema),
  },

  handle: async (context, params) => {
    const validatedParams = selectOptionSchema.parse(params);
    return await runAndWait(context, `Selected option in "${validatedParams.element}"`, async () => {
      const locator = context.refLocator(validatedParams.ref);
      await locator.selectOption(validatedParams.values);
    }, true);
  },
};

const screenshotSchema = z.object({
  raw: z.boolean().optional().describe('Whether to return without compression (in PNG format). Default is false, which returns a JPEG image.'),
});

export const screenshot: Tool = {
  schema: {
    name: 'browser_take_screenshot',
    description: `Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.`,
    inputSchema: zodToJsonSchema(screenshotSchema),
  },

  handle: async (context, params) => {
    const validatedParams = screenshotSchema.parse(params);
    const page = context.existingPage();
    const options: playwright.PageScreenshotOptions = validatedParams.raw ? { type: 'png', scale: 'css' } : { type: 'jpeg', quality: 50, scale: 'css' };
    const screenshot = await page.screenshot(options);
    return {
      content: [{ type: 'image', data: screenshot.toString('base64'), mimeType: validatedParams.raw ? 'image/png' : 'image/jpeg' }],
    };
  },
};

const htmlSnippetSchema = z.object({
  element: z.string().describe('Human-readable element description used to obtain permission to interact with the element').optional(),
  ref: z.string().describe('Exact target element reference from the page snapshot').optional(),
  includeOuter: z.boolean().describe('Whether to include the outer HTML of the selected element. Default is false.').optional(),
  filterTags: z.array(z.string()).describe('List of HTML tag names to filter out from the result. Default removes meta, script, style, and link tags.').optional(),
});

export const htmlSnippet: Tool = {
  schema: {
    name: 'browser_take_html_snippet',
    description: 'Retrieve the HTML content of the current page or a specific element',
    inputSchema: zodToJsonSchema(htmlSnippetSchema),
  },

  handle: async (context, params) => {
    const validatedParams = htmlSnippetSchema.parse(params);
    const page = context.existingPage();
    
    let html: string;
    
    if (validatedParams.ref) {
      // Get HTML of a specific element
      const locator = context.refLocator(validatedParams.ref);
      if (validatedParams.includeOuter) {
        html = await locator.evaluate((el) => el.outerHTML);
      } else {
        html = await locator.evaluate((el) => el.innerHTML);
      }
    } else {
      // Get HTML of the entire page
      html = await page.content();
    }
    
    // Filter out specified tags
    const tagsToFilter = validatedParams.filterTags || ['meta', 'script', 'style', 'link'];
    
    if (tagsToFilter.length > 0) {
      html = await page.evaluate(
        ({ htmlContent, tags }) => {
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlContent, 'text/html');
          
          // Filter out each specified tag
          for (const tag of tags) {
            const elements = doc.getElementsByTagName(tag);
            // Remove elements from last to first to avoid index shifting
            for (let i = elements.length - 1; i >= 0; i--) {
              const element = elements[i];
              element.parentNode?.removeChild(element);
            }
          }
          
          // Return serialized HTML
          return doc.documentElement.outerHTML;
        },
        { htmlContent: html, tags: tagsToFilter }
      );
    }
    
    // Format the HTML for better readability
    const formattedHtml = await page.evaluate(
      ({ htmlContent }) => {
        // Function to format HTML with proper indentation
        function formatHTML(html: string): string {
          let formatted = '';
          let indent = '';
          
          // Helper function to get appropriate indent
          const getIndent = () => {
            let result = '';
            for (let i = 0; i < indent.length; i++) {
              result += ' ';
            }
            return result;
          };
          
          // Parse the HTML into a document
          const doc = new DOMParser().parseFromString(html, 'text/html');
          
          // Function to process a node recursively
          function processNode(node: Node, level: number): void {
            indent = '  '.repeat(level);
            
            if (node.nodeType === 3) { // Text node
              const text = node.textContent?.trim() || '';
              if (text) {
                formatted += getIndent() + text + '\n';
              }
            } else if (node.nodeType === 1) { // Element node
              const tagName = node.nodeName.toLowerCase();
              
              // Opening tag
              formatted += getIndent() + '<' + tagName;
              
              // Attributes
              const element = node as Element;
              Array.from(element.attributes).forEach(attr => {
                formatted += ' ' + attr.name + '="' + attr.value + '"';
              });
              
              if (node.childNodes.length === 0) {
                // Self-closing tag
                formatted += ' />\n';
              } else {
                formatted += '>\n';
                
                // Process children
                Array.from(node.childNodes).forEach(child => {
                  processNode(child, level + 1);
                });
                
                // Closing tag
                formatted += getIndent() + '</' + tagName + '>\n';
              }
            }
          }
          
          // Process the document element
          if (doc.documentElement) {
            processNode(doc.documentElement, 0);
          }
          
          return formatted;
        }
        
        return formatHTML(htmlContent);
      },
      { htmlContent: html }
    );
    
    return {
      content: [{ type: 'text', text: '```html\n' + formattedHtml + '```' }],
    };
  },
};
