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

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { RecorderCollection } from './recorderCollection';
import * as recorderSource from '../../generated/pollingRecorderSource';
import { eventsHelper, monotonicTime, quoteCSSAttributeValue  } from '../../utils';
import { raceAgainstDeadline } from '../../utils/isomorphic/timeoutRunner';
import { BrowserContext } from '../browserContext';
import { languageSet } from '../codegen/languages';
import { Frame } from '../frames';
import { Page } from '../page';
import { ThrottledFile } from './throttledFile';
import { generateCode } from '../codegen/language';
import { serverSideCallMetadata } from '../instrumentation';
import { ProgressController } from '../progress';

import type { RegisteredListener } from '../../utils';
import type { Language, LanguageGenerator, LanguageGeneratorOptions } from '../codegen/types';
import type { Dialog } from '../dialog';
import type * as channels from '@protocol/channels';
import type * as actions from '@recorder/actions';
import type { Source } from '@recorder/recorderTypes';

type BindingSource = { frame: Frame, page: Page };

export interface ContextRecorderDelegate {
  rewriteActionInContext?(pageAliases: Map<Page, string>, actionInContext: actions.ActionInContext): Promise<void>;
}

export class ContextRecorder extends EventEmitter {
  static Events = {
    Change: 'change'
  };

  private _collection: RecorderCollection;
  private _pageAliases = new Map<Page, string>();
  private _lastPopupOrdinal = 0;
  private _lastDialogOrdinal = -1;
  private _lastDownloadOrdinal = -1;
  private _context: BrowserContext;
  private _params: channels.BrowserContextEnableRecorderParams;
  private _delegate: ContextRecorderDelegate;
  private _recorderSources: Source[];
  private _throttledOutputFile: ThrottledFile | null = null;
  private _orderedLanguages: LanguageGenerator[] = [];
  private _listeners: RegisteredListener[] = [];
  private _initialPageCaptured = false;
  private _isCapturingInitialPage = false;
  private _sessionName: string;
  private _actionCounter = 0;
  private _sessionId: string;
  private _lastNavigationTimestamp = 0;
  private _lastSnapshotTimestamp = 0;

  constructor(context: BrowserContext, params: channels.BrowserContextEnableRecorderParams, delegate: ContextRecorderDelegate) {
    super();
    this._context = context;
    this._params = params;
    this._delegate = delegate;
    this._recorderSources = [];
    const language = params.language || context.attribution.playwright.options.sdkLanguage;
    this.setOutput(language, params.outputFile);
    
    // Use browser context ID if available, or generate a random ID
    this._sessionId = context._browserContextId || `sid-${Math.random().toString(36).substring(2, 10)}`;
    
    // Generate a session name based on timestamp and session ID
    this._sessionName = `session-${this._sessionId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Make a copy of options to modify them later.
    const languageGeneratorOptions: LanguageGeneratorOptions = {
      browserName: context._browser.options.name,
      launchOptions: { headless: false, ...params.launchOptions, tracesDir: undefined },
      contextOptions: { ...params.contextOptions },
      deviceName: params.device,
      saveStorage: params.saveStorage,
    };

    this._collection = new RecorderCollection(this._pageAliases);
    this._collection.on('change', (actions: actions.ActionInContext[]) => {
      this._recorderSources = [];
      for (const languageGenerator of this._orderedLanguages) {
        const { header, footer, actionTexts, text } = generateCode(actions, languageGenerator, languageGeneratorOptions);
        const source: Source = {
          isRecorded: true,
          label: languageGenerator.name,
          group: languageGenerator.groupName,
          id: languageGenerator.id,
          text,
          header,
          footer,
          actions: actionTexts,
          language: languageGenerator.highlighter,
          highlight: []
        };
        source.revealLine = text.split('\n').length - 1;
        this._recorderSources.push(source);
        if (languageGenerator === this._orderedLanguages[0])
          this._throttledOutputFile?.setContent(source.text);
      }
      this.emit(ContextRecorder.Events.Change, {
        sources: this._recorderSources,
        actions
      });
    });
    context.on(BrowserContext.Events.BeforeClose, () => {
      this._throttledOutputFile?.flush();
    });
    this._listeners.push(eventsHelper.addEventListener(process, 'exit', () => {
      this._throttledOutputFile?.flush();
    }));
    this.setEnabled(params.mode === 'recording');
  }

  setOutput(codegenId: string, outputFile?: string) {
    const languages = languageSet();
    const primaryLanguage = [...languages].find(l => l.id === codegenId);
    if (!primaryLanguage)
      throw new Error(`\n===============================\nUnsupported language: '${codegenId}'\n===============================\n`);
    languages.delete(primaryLanguage);
    this._orderedLanguages = [primaryLanguage, ...languages];
    this._throttledOutputFile = outputFile ? new ThrottledFile(outputFile) : null;
    this._collection?.restart();
  }

  languageName(id?: string): Language {
    for (const lang of this._orderedLanguages) {
      if (!id || lang.id === id)
        return lang.highlighter;
    }
    return 'javascript';
  }

  async install() {
    this._context.on(BrowserContext.Events.Page, (page: Page) => this._onPage(page));
    for (const page of this._context.pages())
      this._onPage(page);
    this._context.on(BrowserContext.Events.Dialog, (dialog: Dialog) => this._onDialog(dialog.page()));

    // Input actions that potentially lead to navigation are intercepted on the page and are
    // performed by the Playwright.
    await this._context.exposeBinding('__pw_recorderPerformAction', false,
        (source: BindingSource, action: actions.PerformOnRecordAction) => this._performAction(source.frame, action));

    // Other non-essential actions are simply being recorded.
    await this._context.exposeBinding('__pw_recorderRecordAction', false,
        (source: BindingSource, action: actions.Action) => this._recordAction(source.frame, action));

    await this._context.extendInjectedScript(recorderSource.source);
  }

  setEnabled(enabled: boolean) {
    this._collection.setEnabled(enabled);
  }

  dispose() {
    eventsHelper.removeEventListeners(this._listeners);
  }

  private async _onPage(page: Page) {
    // First page is called page, others are called popup1, popup2, etc.
    const frame = page.mainFrame();
    page.on('close', () => {
      this._collection.addRecordedAction({
        frame: this._describeMainFrame(page),
        action: {
          name: 'closePage',
          signals: [],
        },
        startTime: monotonicTime()
      });
      this._pageAliases.delete(page);
    });
    frame.on(Frame.Events.InternalNavigation, event => {
      console.log('Internal navigation event:', frame.url());
      if (event.isPublic)
        this._onFrameNavigated(frame, page);
    });
    page.on(Page.Events.Download, () => this._onDownload(page));
    const suffix = this._pageAliases.size ? String(++this._lastPopupOrdinal) : '';
    const pageAlias = 'page' + suffix;
    this._pageAliases.set(page, pageAlias);

    if (page.opener()) {
      this._onPopup(page.opener()!, page);
    } else {
      this._collection.addRecordedAction({
        frame: this._describeMainFrame(page),
        action: {
          name: 'openPage',
          url: page.mainFrame().url(),
          signals: [],
        },
        startTime: monotonicTime()
      });
    }
  }

  clearScript(): void {
    this._collection.restart();
    if (this._params.mode === 'recording') {
      for (const page of this._context.pages())
        this._onFrameNavigated(page.mainFrame(), page);
    }
  }

  runTask(task: string): void {
    // TODO: implement
  }

  private _describeMainFrame(page: Page): actions.FrameDescription {
    return {
      pageAlias: this._pageAliases.get(page)!,
      framePath: [],
    };
  }

  private async _describeFrame(frame: Frame): Promise<actions.FrameDescription> {
    return {
      pageAlias: this._pageAliases.get(frame._page)!,
      framePath: await generateFrameSelector(frame),
    };
  }

  testIdAttributeName(): string {
    return this._params.testIdAttributeName || this._context.selectors().testIdAttributeName() || 'data-testid';
  }

  private async _createActionInContext(frame: Frame, action: actions.Action): Promise<actions.ActionInContext> {
    const frameDescription = await this._describeFrame(frame);
    const actionInContext: actions.ActionInContext = {
      frame: frameDescription,
      action,
      description: undefined,
      startTime: monotonicTime()
    };
    await this._delegate.rewriteActionInContext?.(this._pageAliases, actionInContext);
    return actionInContext;
  }

  private async _performAction(frame: Frame, action: actions.PerformOnRecordAction) {
    const beforeState = await this._capturePageState(frame);
    const actionInContext = await this._createActionInContext(frame, action);
    await this._collection.performAction(actionInContext);
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const afterState = await this._capturePageState(frame);
    if (this._hasStateChanged(beforeState, afterState)) {
      const now = Date.now();
      // Skip if we just took a snapshot (within last 2 seconds)
      if (now - this._lastSnapshotTimestamp < 2000) {
        console.log('_performAction:  skipping the snapshot one');
        return;
      }
      await this._savePageSnapshot(frame, action);
      this._lastSnapshotTimestamp = Date.now();
    }
  }

  private async _recordAction(frame: Frame, action: actions.Action) {
    this._collection.addRecordedAction(await this._createActionInContext(frame, action));
  }

  private async _capturePageState(frame: Frame): Promise<{ html: string, url: string }> {
    try {
      const page = frame._page;
      const html = await frame.content();
      const url = page.mainFrame().url();
      return { html, url };
    } catch (error) {
      console.error('Error capturing page state:', error);
      return { html: '', url: '' };
    }
  }

  private _hasStateChanged(beforeState: { html: string, url: string }, afterState: { html: string, url: string }): boolean {
    // Check if URL has changed
    if (beforeState.url !== afterState.url) {
      return true;
    }
    
    // Simple HTML comparison - ignore minor differences that don't affect the page structure
    // Remove dynamic content like timestamps, random IDs, etc.
    const normalizeHtml = (html: string) => {
      return html
        .replace(/\s+/g, ' ')                // Normalize whitespace
        .replace(/<!--.*?-->/g, '')          // Remove comments
        .replace(/\sdata-[-\w]+=["'][^"']*["']/g, '') // Remove data attributes
        .replace(/\sid=["'][^"']*["']/g, '') // Remove IDs
        .trim();
    };
    
    const normalizedBefore = normalizeHtml(beforeState.html);
    const normalizedAfter = normalizeHtml(afterState.html);
    
    // If the normalized HTML differs significantly, consider it changed
    // This helps avoid capturing snapshots for minor DOM changes
    if (normalizedBefore !== normalizedAfter) {
      // Calculate a simple difference ratio
      const maxLength = Math.max(normalizedBefore.length, normalizedAfter.length);
      let diffCount = 0;
      
      for (let i = 0; i < Math.min(normalizedBefore.length, normalizedAfter.length); i++) {
        if (normalizedBefore[i] !== normalizedAfter[i]) {
          diffCount++;
        }
      }
      
      diffCount += Math.abs(normalizedBefore.length - normalizedAfter.length);
      const diffRatio = diffCount / maxLength;
      
      // Only consider it changed if the difference is significant (more than 1%)
      return diffRatio > 0.01;
    }
    
    return false;
  }

  private async _savePageSnapshot(frame: Frame, action: actions.Action, prefix?: string) {
    try {
      const page = frame._page;
      
      // Get current timestamp for the filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      
      // For initial page, use "00-initial" as action number
      // For regular actions, use padded numbers like "01-click", "02-fill" to ensure proper sorting
      let actionNumber;
      let actionDescription = '';
      
      if (prefix === 'initial') {
        actionNumber = '00-initial';
      } else {
        // Increment counter and pad with leading zeros (01, 02, etc.)
        this._actionCounter++;
        const paddedCounter = String(this._actionCounter).padStart(2, '0');
        
        // Add action name to the filename for better identification
        actionDescription = `-${action.name}`;
        actionNumber = `${paddedCounter}${actionDescription}`;
      }
      
      // Use the snapshotsDir parameter if provided, otherwise use default "playwright-snapshots"
      const baseDir = this._params.snapshotsDir || 'playwright-snapshots';
      
      // Use session name for the folder
      const snapshotDir = path.join(baseDir, this._sessionName);
      
      // Create directory if it doesn't exist (create parent directories as needed)
      fs.mkdirSync(baseDir, { recursive: true });
      fs.mkdirSync(snapshotDir, { recursive: true });
      
      // Save HTML content with improved naming
      const content = await frame.content();
      const htmlPath = path.join(snapshotDir, `${actionNumber}-${timestamp}.html`);
      fs.writeFileSync(htmlPath, content);
      
      // Take screenshot with matching filename
      const metadata = serverSideCallMetadata();
      const screenshotOptions = { fullPage: true };
      const screenshotBuffer = await page.screenshot(metadata, screenshotOptions);
      const screenshotPath = path.join(snapshotDir, `${actionNumber}-${timestamp}.png`);
      fs.writeFileSync(screenshotPath, screenshotBuffer);
      
      // Capture and save aria snapshot
      const ariaSnapshot = await frame.ariaSnapshot(metadata, 'html', { ref: true });
      const ariaPath = path.join(snapshotDir, `${actionNumber}-${timestamp}.aria.txt`);
      fs.writeFileSync(ariaPath, ariaSnapshot);
      
      if (prefix === 'initial') {
        console.log(`Saved initial page snapshot to ${snapshotDir}/${actionNumber}-${timestamp}.html`);
      } else {
        console.log(`Saved page snapshot for ${action.name} to ${snapshotDir}/${actionNumber}-${timestamp}.html`);
      }
    } catch (error) {
      console.error('Error saving page snapshot:', error);
    }
  }

  private async _onFrameNavigated(frame: Frame, page: Page) {
    const now = Date.now();
    // Skip if we just took a snapshot from _performAction (within last 2 seconds)
    if (now - this._lastSnapshotTimestamp < 2000) {
        //Naviaget snapshot can happen both in _performAction and _onFrameNavigated,
        console.log('_onFrameNavigated:  skipping the snapshot one');
        return;
    }
    
    try {
        console.log('Navigated to:', frame.url());
        console.log('Capturing page state on navigation to:', frame.url());
        this._lastSnapshotTimestamp = now;
        // Create a progress controller for load state waiting
        const progress = new ProgressController(serverSideCallMetadata(), frame);
        
        try {
          await progress.run(async progress => {
            await Promise.race([
              // Main loading states with timeout
              Promise.all([
                frame._waitForLoadState(progress, 'domcontentloaded'),
                frame._waitForLoadState(progress, 'load')
              ]).then(async () => {
                // Give a small grace period for any immediate post-load operations
                await new Promise(resolve => setTimeout(resolve,  1500));
              }),
              // Timeout after 30 seconds
              new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout')), 30000))
            ]);
          });
        } catch (error) {
          if (error.message === 'Load timeout') {
            console.log('Load state timeout reached, proceeding with snapshot');
          } else {
            throw error;
          }
        }
        
        const currentAction: actions.Action = {
          name: 'navigate',
          url: frame.url(),
          signals: [],
        };
        await this._savePageSnapshot(frame, currentAction);
        
        
    } catch (error) {
      console.error('Error capturing page state:', error);
    }

    const pageAlias = this._pageAliases.get(page);
    this._collection.signal(pageAlias!, frame, { name: 'navigation', url: frame.url() });
  }

  private _onPopup(page: Page, popup: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    const popupAlias = this._pageAliases.get(popup)!;
    this._collection.signal(pageAlias, page.mainFrame(), { name: 'popup', popupAlias });
  }

  private _onDownload(page: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    ++this._lastDownloadOrdinal;
    this._collection.signal(pageAlias, page.mainFrame(), { name: 'download', downloadAlias: this._lastDownloadOrdinal ? String(this._lastDownloadOrdinal) : '' });
  }

  private _onDialog(page: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    ++this._lastDialogOrdinal;
    this._collection.signal(pageAlias, page.mainFrame(), { name: 'dialog', dialogAlias: this._lastDialogOrdinal ? String(this._lastDialogOrdinal) : '' });
  }
}

export async function generateFrameSelector(frame: Frame): Promise<string[]> {
  const selectorPromises: Promise<string>[] = [];
  while (frame) {
    const parent = frame.parentFrame();
    if (!parent)
      break;
    selectorPromises.push(generateFrameSelectorInParent(parent, frame));
    frame = parent;
  }
  const result = await Promise.all(selectorPromises);
  return result.reverse();
}

async function generateFrameSelectorInParent(parent: Frame, frame: Frame): Promise<string> {
  const result = await raceAgainstDeadline(async () => {
    try {
      const frameElement = await frame.frameElement();
      if (!frameElement || !parent)
        return;
      const utility = await parent._utilityContext();
      const injected = await utility.injectedScript();
      const selector = await injected.evaluate((injected, element) => {
        return injected.generateSelectorSimple(element as Element);
      }, frameElement);
      return selector;
    } catch (e) {
    }
  }, monotonicTime() + 2000);
  if (!result.timedOut && result.result)
    return result.result;

  if (frame.name())
    return `iframe[name=${quoteCSSAttributeValue(frame.name())}]`;
  return `iframe[src=${quoteCSSAttributeValue(frame.url())}]`;
}
