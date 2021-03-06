import { LanguageModelCache, getLanguageModelCache } from '../../embeddedSupport/languageModelCache';
import {
  SymbolInformation,
  CompletionItem,
  Location,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Command,
  Definition,
  TextEdit,
  TextDocument,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  CompletionItemKind,
  Hover,
  MarkedString,
  DocumentHighlight,
  DocumentHighlightKind,
  CompletionList,
  Position,
  FormattingOptions,
  DiagnosticTag,
  MarkupContent,
  InsertTextFormat,
  CodeAction,
  CodeActionKind,
  CodeActionContext
} from 'vscode-languageserver-types';
import { LanguageMode } from '../../embeddedSupport/languageModes';
import { VueDocumentRegions, LanguageRange } from '../../embeddedSupport/embeddedSupport';
import { prettierify, prettierEslintify, prettierTslintify } from '../../utils/prettier';
import { getFileFsPath, getFilePath } from '../../utils/paths';

import Uri from 'vscode-uri';
import * as ts from 'typescript';
import * as _ from 'lodash';

import { nullMode, NULL_SIGNATURE } from '../nullMode';
import { VLSFormatConfig } from '../../config';
import { VueInfoService } from '../../services/vueInfoService';
import { getComponentInfo } from './componentInfo';
import { DependencyService, T_TypeScript, State } from '../../services/dependencyService';
import { RefactorAction, CodeActionReq, CodeActionReqKind } from '../../types';
import { IServiceHost } from '../../services/typescriptService/serviceHost';
import { toCompletionItemKind, toSymbolKind } from '../../services/typescriptService/util';

// Todo: After upgrading to LS server 4.0, use CompletionContext for filtering trigger chars
// https://microsoft.github.io/language-server-protocol/specification#completion-request-leftwards_arrow_with_hook
const NON_SCRIPT_TRIGGERS = ['<', '*', ':'];

export async function getJavascriptMode(
  serviceHost: IServiceHost,
  documentRegions: LanguageModelCache<VueDocumentRegions>,
  workspacePath: string | undefined,
  vueInfoService?: VueInfoService,
  dependencyService?: DependencyService
): Promise<LanguageMode> {
  if (!workspacePath) {
    return {
      ...nullMode
    };
  }
  const jsDocuments = getLanguageModelCache(10, 60, document => {
    const vueDocument = documentRegions.refreshAndGet(document);
    return vueDocument.getSingleTypeDocument('script');
  });

  const firstScriptRegion = getLanguageModelCache(10, 60, document => {
    const vueDocument = documentRegions.refreshAndGet(document);
    const scriptRegions = vueDocument.getLanguageRangesOfType('script');
    return scriptRegions.length > 0 ? scriptRegions[0] : undefined;
  });

  let tsModule: T_TypeScript = ts;
  if (dependencyService) {
    const tsDependency = dependencyService.getDependency('typescript');
    if (tsDependency && tsDependency.state === State.Loaded) {
      tsModule = tsDependency.module;
    }
  }

  const { updateCurrentVueTextDocument } = serviceHost;
  let config: any = {};
  let supportedCodeFixCodes: Set<number>;

  return {
    getId() {
      return 'javascript';
    },
    configure(c) {
      config = c;
    },
    updateFileInfo(doc: TextDocument): void {
      if (!vueInfoService) {
        return;
      }

      const { service } = updateCurrentVueTextDocument(doc);
      const fileFsPath = getFileFsPath(doc.uri);
      const info = getComponentInfo(tsModule, service, fileFsPath, config);
      if (info) {
        vueInfoService.updateInfo(doc, info);
      }
    },

    doValidation(doc: TextDocument): Diagnostic[] {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const rawScriptDiagnostics = [
        ...service.getSyntacticDiagnostics(fileFsPath),
        ...service.getSemanticDiagnostics(fileFsPath),
        ...service.getSuggestionDiagnostics(fileFsPath)
      ];

      return rawScriptDiagnostics.map(diag => {
        const tags: DiagnosticTag[] = [];

        if (diag.reportsUnnecessary) {
          tags.push(DiagnosticTag.Unnecessary);
        }

        // syntactic/semantic diagnostic always has start and length
        // so we can safely cast diag to TextSpan
        return <Diagnostic>{
          range: convertRange(scriptDoc, diag as ts.TextSpan),
          severity: convertTSDiagnosticCategoryToDiagnosticSeverity(diag.category),
          message: tsModule.flattenDiagnosticMessageText(diag.messageText, '\n'),
          tags,
          code: diag.code,
          source: 'Vetur'
        };
      });
    },
    doComplete(doc: TextDocument, position: Position): CompletionList {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return { isIncomplete: false, items: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const offset = scriptDoc.offsetAt(position);
      const triggerChar = doc.getText()[offset - 1];
      if (NON_SCRIPT_TRIGGERS.includes(triggerChar)) {
        return { isIncomplete: false, items: [] };
      }
      const completions = service.getCompletionsAtPosition(fileFsPath, offset, {
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: _.get(config, ['vetur', 'completion', 'autoImport'])
      });
      if (!completions) {
        return { isIncomplete: false, items: [] };
      }
      const entries = completions.entries.filter(entry => entry.name !== '__vueEditorBridge');
      return {
        isIncomplete: false,
        items: entries.map(entry => {
          const range = entry.replacementSpan && convertRange(scriptDoc, entry.replacementSpan);
          const filterText = entry.insertText && range && entry.insertText[0] === '[' ? '.' + entry.name : undefined;
          const { label, detail } = calculateLabelAndDetailTextForPathImport(entry);
          const kind = toCompletionItemKind(entry.kind);
          const insertTextFormat =
            kind === CompletionItemKind.Function || kind === CompletionItemKind.Method
              ? InsertTextFormat.Snippet
              : undefined;
          const insertText = entry.insertText || entry.name;

          return {
            uri: doc.uri,
            position,
            preselect: entry.isRecommended ? true : undefined,
            label,
            detail,
            filterText,
            insertTextFormat,
            sortText: entry.sortText,
            kind: toCompletionItemKind(entry.kind),
            textEdit: range && TextEdit.replace(range, insertText),
            insertText: range ? undefined : insertText,
            data: {
              // data used for resolving item details (see 'doResolve')
              languageId: scriptDoc.languageId,
              uri: doc.uri,
              offset,
              source: entry.source
            }
          };
        })
      };

      function calculateLabelAndDetailTextForPathImport(entry: ts.CompletionEntry) {
        // Is import path completion
        if (entry.kind === ts.ScriptElementKind.scriptElement) {
          if (entry.kindModifiers) {
            return {
              label: entry.name,
              detail: entry.name + entry.kindModifiers
            };
          } else {
            if (entry.name.endsWith('.vue')) {
              return {
                label: entry.name.slice(0, -'.vue'.length),
                detail: entry.name
              };
            }
          }
        }

        return {
          label: entry.name,
          detail: undefined
        };
      }
    },
    doResolve(doc: TextDocument, item: CompletionItem): CompletionItem {
      const { service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return item;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const details = service.getCompletionEntryDetails(
        fileFsPath,
        item.data.offset,
        item.label,
        getFormatCodeSettings(config),
        item.data.source,
        {
          importModuleSpecifierEnding: 'minimal',
          importModuleSpecifierPreference: 'relative',
          includeCompletionsWithInsertText: true
        }
      );
      if (details && item.kind !== CompletionItemKind.File && item.kind !== CompletionItemKind.Folder) {
        item.detail = tsModule.displayPartsToString(details.displayParts);
        const documentation: MarkupContent = {
          kind: 'markdown',
          value: tsModule.displayPartsToString(details.documentation)
        };
        if (details.codeActions && config.vetur.completion.autoImport) {
          const textEdits = convertCodeAction(doc, details.codeActions, firstScriptRegion);
          item.additionalTextEdits = textEdits;

          details.codeActions.forEach(action => {
            if (action.description) {
              documentation.value += '\n' + action.description;
            }
          });
        }
        item.documentation = documentation;
        delete item.data;
      }
      return item;
    },
    doHover(doc: TextDocument, position: Position): Hover {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return { contents: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const info = service.getQuickInfoAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (info) {
        const display = tsModule.displayPartsToString(info.displayParts);
        const doc = tsModule.displayPartsToString(info.documentation);
        const markedContents: MarkedString[] = [{ language: 'ts', value: display }];
        if (doc) {
          markedContents.unshift(doc, '\n');
        }
        return {
          range: convertRange(scriptDoc, info.textSpan),
          contents: markedContents
        };
      }
      return { contents: [] };
    },
    doSignatureHelp(doc: TextDocument, position: Position): SignatureHelp | null {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return NULL_SIGNATURE;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const signHelp = service.getSignatureHelpItems(fileFsPath, scriptDoc.offsetAt(position), undefined);
      if (!signHelp) {
        return NULL_SIGNATURE;
      }
      const ret: SignatureHelp = {
        activeSignature: signHelp.selectedItemIndex,
        activeParameter: signHelp.argumentIndex,
        signatures: []
      };
      signHelp.items.forEach(item => {
        const signature: SignatureInformation = {
          label: '',
          documentation: undefined,
          parameters: []
        };

        signature.label += tsModule.displayPartsToString(item.prefixDisplayParts);
        item.parameters.forEach((p, i, a) => {
          const label = tsModule.displayPartsToString(p.displayParts);
          const parameter: ParameterInformation = {
            label,
            documentation: tsModule.displayPartsToString(p.documentation)
          };
          signature.label += label;
          signature.parameters!.push(parameter);
          if (i < a.length - 1) {
            signature.label += tsModule.displayPartsToString(item.separatorDisplayParts);
          }
        });
        signature.label += tsModule.displayPartsToString(item.suffixDisplayParts);
        ret.signatures.push(signature);
      });
      return ret;
    },
    findDocumentHighlight(doc: TextDocument, position: Position): DocumentHighlight[] {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const occurrences = service.getOccurrencesAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (occurrences) {
        return occurrences.map(entry => {
          return {
            range: convertRange(scriptDoc, entry.textSpan),
            kind: entry.isWriteAccess ? DocumentHighlightKind.Write : DocumentHighlightKind.Text
          };
        });
      }
      return [];
    },
    findDocumentSymbols(doc: TextDocument): SymbolInformation[] {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const items = service.getNavigationBarItems(fileFsPath);
      if (!items) {
        return [];
      }
      const result: SymbolInformation[] = [];
      const existing: { [k: string]: boolean } = {};
      const collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
        const sig = item.text + item.kind + item.spans[0].start;
        if (item.kind !== 'script' && !existing[sig]) {
          const symbol: SymbolInformation = {
            name: item.text,
            kind: toSymbolKind(item.kind),
            location: {
              uri: doc.uri,
              range: convertRange(scriptDoc, item.spans[0])
            },
            containerName: containerLabel
          };
          existing[sig] = true;
          result.push(symbol);
          containerLabel = item.text;
        }

        if (item.childItems && item.childItems.length > 0) {
          for (const child of item.childItems) {
            collectSymbols(child, containerLabel);
          }
        }
      };

      items.forEach(item => collectSymbols(item));
      return result;
    },
    findDefinition(doc: TextDocument, position: Position): Definition {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const definitions = service.getDefinitionAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (!definitions) {
        return [];
      }

      const definitionResults: Definition = [];
      const program = service.getProgram();
      if (!program) {
        return [];
      }
      definitions.forEach(d => {
        const definitionTargetDoc = getSourceDoc(d.fileName, program);
        definitionResults.push({
          uri: Uri.file(d.fileName).toString(),
          range: convertRange(definitionTargetDoc, d.textSpan)
        });
      });
      return definitionResults;
    },
    findReferences(doc: TextDocument, position: Position): Location[] {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const references = service.getReferencesAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (!references) {
        return [];
      }

      const referenceResults: Location[] = [];
      const program = service.getProgram();
      if (!program) {
        return [];
      }
      references.forEach(r => {
        const referenceTargetDoc = getSourceDoc(r.fileName, program);
        if (referenceTargetDoc) {
          referenceResults.push({
            uri: Uri.file(r.fileName).toString(),
            range: convertRange(referenceTargetDoc, r.textSpan)
          });
        }
      });
      return referenceResults;
    },
    getCodeActions(doc, range, _formatParams, context) {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);
      const fileName = getFileFsPath(scriptDoc.uri);
      const start = scriptDoc.offsetAt(range.start);
      const end = scriptDoc.offsetAt(range.end);
      const textRange = { pos: start, end };
      if (!supportedCodeFixCodes) {
        supportedCodeFixCodes = new Set(
          ts
            .getSupportedCodeFixes()
            .map(Number)
            .filter(x => !isNaN(x))
        );
      }

      const formatSettings: ts.FormatCodeSettings = getFormatCodeSettings(config);

      const result: CodeAction[] = [];

      provideQuickFixCodeActions(
        fileName,
        textRange,
        context,
        supportedCodeFixCodes,
        formatSettings,
        /*preferences*/ {},
        service,
        result
      );
      provideOrganizeImports(fileName, textRange, context, formatSettings, /*preferences*/ {}, service, result);
      provideRefactoringCommands(fileName, textRange, context, formatSettings, /*preferences*/ {}, service, result);

      return result;
    },
    getCodeActionEdits(doc: TextDocument, req: CodeActionReq) {
      const { service } = updateCurrentVueTextDocument(doc);

      if (req.kind === CodeActionReqKind.RefactorAction) {
        const args = req.arguments;
        const response = service.getEditsForRefactor(
          req.fileName,
          req.formatSettings,
          req.textRange,
          args.refactorName,
          args.actionName,
          req.preferences
        );
        if (!response) {
          // TODO: What happens when there's no response?
          return createApplyCodeActionCommand('', {});
        }
        const uriMapping = createUriMappingForEdits(response.edits, service);
        return createApplyCodeActionCommand('', uriMapping);
      }

      if (req.kind === CodeActionReqKind.CombinedCodeFix) {
        const fix = service.getCombinedCodeFix(
          { type: 'file', fileName: req.fileName },
          req.arguments.fixId,
          req.formatSettings,
          req.preferences
        );

        const uriMapping = createUriMappingForEdits(fix.changes.slice(), service);
        return createApplyCodeActionCommand('', uriMapping);
      }

      if (req.kind === CodeActionReqKind.OrganizeImports) {
        const response = service.organizeImports(
          { type: 'file', fileName: req.fileName },
          req.formatSettings,
          req.preferences
        );

        const uriMapping = createUriMappingForEdits(response.slice(), service);
        return createApplyCodeActionCommand('', uriMapping);
      }

      return createApplyCodeActionCommand('', {});
    },
    format(doc: TextDocument, range: Range, formatParams: FormattingOptions): TextEdit[] {
      const { scriptDoc, service } = updateCurrentVueTextDocument(doc);

      const defaultFormatter =
        scriptDoc.languageId === 'javascript'
          ? config.vetur.format.defaultFormatter.js
          : config.vetur.format.defaultFormatter.ts;

      if (defaultFormatter === 'none') {
        return [];
      }

      const parser = scriptDoc.languageId === 'javascript' ? 'babylon' : 'typescript';
      const needInitialIndent = config.vetur.format.scriptInitialIndent;
      const vlsFormatConfig: VLSFormatConfig = config.vetur.format;

      if (
        defaultFormatter === 'prettier' ||
        defaultFormatter === 'prettier-eslint' ||
        defaultFormatter === 'prettier-tslint'
      ) {
        const code = doc.getText(range);
        const filePath = getFileFsPath(scriptDoc.uri);
        let doFormat;
        if (defaultFormatter === 'prettier-eslint') {
          doFormat = prettierEslintify;
        } else if (defaultFormatter === 'prettier-tslint') {
          doFormat = prettierTslintify;
        } else {
          doFormat = prettierify;
        }
        return doFormat(code, filePath, range, vlsFormatConfig, parser, needInitialIndent);
      } else {
        const initialIndentLevel = needInitialIndent ? 1 : 0;
        const formatSettings: ts.FormatCodeSettings =
          scriptDoc.languageId === 'javascript' ? config.javascript.format : config.typescript.format;
        const convertedFormatSettings = convertOptions(
          formatSettings,
          {
            tabSize: vlsFormatConfig.options.tabSize,
            insertSpaces: !vlsFormatConfig.options.useTabs
          },
          initialIndentLevel
        );

        const fileFsPath = getFileFsPath(doc.uri);
        const start = scriptDoc.offsetAt(range.start);
        const end = scriptDoc.offsetAt(range.end);
        const edits = service.getFormattingEditsForRange(fileFsPath, start, end, convertedFormatSettings);

        if (!edits) {
          return [];
        }
        const result = [];
        for (const edit of edits) {
          if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
            result.push({
              range: convertRange(scriptDoc, edit.span),
              newText: edit.newText
            });
          }
        }
        return result;
      }
    },
    onDocumentRemoved(document: TextDocument) {
      jsDocuments.onDocumentRemoved(document);
    },
    onDocumentChanged(filePath: string) {
      serviceHost.updateExternalDocument(filePath);
    },
    dispose() {
      jsDocuments.dispose();
    }
  };
}

function provideRefactoringCommands(
  fileName: string,
  textRange: { pos: number; end: number },
  context: CodeActionContext,
  formatSettings: ts.FormatCodeSettings,
  preferences: ts.UserPreferences,
  service: ts.LanguageService,
  result: CodeAction[]
) {
  if (
    context.only &&
    !context.only.some(el =>
      [
        CodeActionKind.Refactor,
        CodeActionKind.RefactorExtract,
        CodeActionKind.RefactorInline,
        CodeActionKind.RefactorRewrite,
        CodeActionKind.Source
      ].includes(el)
    )
  ) {
    return;
  }

  const refactorings = service.getApplicableRefactors(fileName, textRange, /*preferences*/ {});

  const actions: CodeActionReq[] = [];
  for (const refactoring of refactorings) {
    const refactorName = refactoring.name;
    if (refactoring.inlineable) {
      actions.push({
        kind: CodeActionReqKind.RefactorAction,
        fileName,
        textRange,
        formatSettings,
        preferences,
        arguments: {
          refactorName,
          actionName: refactorName,
          description: refactoring.description
        }
      });
    } else {
      actions.push(
        ...refactoring.actions.map(
          action =>
            ({
              kind: CodeActionReqKind.RefactorAction,
              fileName,
              textRange,
              formatSettings,
              preferences,
              arguments: {
                refactorName,
                actionName: action.name,
                description: action.description
              }
            } as CodeActionReq)
        )
      );
    }
  }
  for (const action of actions) {
    result.push({
      title: (action.arguments as RefactorAction).description,
      kind: CodeActionKind.Refactor,
      command: createRequestCodeActionCommand((action.arguments as RefactorAction).description, action)
    });
  }
}

function provideQuickFixCodeActions(
  fileName: string,
  textRange: { pos: number; end: number },
  context: CodeActionContext,
  supportedCodeFixCodes: Set<number>,
  formatSettings: ts.FormatCodeSettings,
  preferences: ts.UserPreferences,
  service: ts.LanguageService,
  result: CodeAction[]
) {
  if (context.only && !context.only.includes(CodeActionKind.QuickFix)) {
    return;
  }

  const fixableDiagnosticCodes = context.diagnostics.map(d => +d.code!).filter(c => supportedCodeFixCodes.has(c));
  if (!fixableDiagnosticCodes) {
    return;
  }

  const fixes = service.getCodeFixesAtPosition(
    fileName,
    textRange.pos,
    textRange.end,
    fixableDiagnosticCodes,
    formatSettings,
    preferences
  );

  for (const fix of fixes) {
    result.push({
      title: fix.description,
      kind: CodeActionKind.QuickFix,
      diagnostics: context.diagnostics,
      command: createApplyCodeActionCommand(fix.description, createUriMappingForEdits(fix.changes, service))
    });
    if (fix.fixAllDescription && fix.fixId) {
      result.push({
        title: fix.fixAllDescription,
        kind: CodeActionKind.QuickFix,
        diagnostics: context.diagnostics,
        command: createRequestCodeActionCommand(fix.fixAllDescription, {
          kind: CodeActionReqKind.CombinedCodeFix,
          fileName,
          textRange,
          formatSettings,
          preferences,
          arguments: {
            fixId: fix.fixId
          }
        })
      });
    }
  }
}

function provideOrganizeImports(
  fileName: string,
  textRange: { pos: number; end: number },
  context: CodeActionContext,
  formatSettings: ts.FormatCodeSettings,
  preferences: ts.UserPreferences,
  service: ts.LanguageService,
  result: CodeAction[]
) {
  if (
    !context.only ||
    (!context.only.includes(CodeActionKind.SourceOrganizeImports) && !context.only.includes(CodeActionKind.Source))
  ) {
    return;
  }

  result.push({
    title: 'Organize Imports',
    kind: CodeActionKind.SourceOrganizeImports,
    command: createRequestCodeActionCommand('Organize Imports', {
      kind: CodeActionReqKind.OrganizeImports,
      fileName,
      textRange,
      formatSettings,
      preferences,
      arguments: {}
    })
  });
}

function createRequestCodeActionCommand(title: string, action: CodeActionReq): Command {
  return {
    title,
    command: 'vetur.chooseTypeScriptCodeAction',
    arguments: [action]
  };
}

function createApplyCodeActionCommand(title: string, uriTextEditMapping: Record<string, TextEdit[]>): Command {
  return {
    title,
    command: 'vetur.applyWorkspaceEdits',
    arguments: [
      {
        changes: uriTextEditMapping
      }
    ]
  };
}

function createUriMappingForEdits(changes: ts.FileTextChanges[], service: ts.LanguageService) {
  const program = service.getProgram()!;
  const result: Record<string, TextEdit[]> = {};
  for (const { fileName, textChanges } of changes) {
    const targetDoc = getSourceDoc(fileName, program);
    const edits = textChanges.map(({ newText, span }) => ({
      newText,
      range: convertRange(targetDoc, span)
    }));
    const uri = Uri.file(fileName).toString();
    if (result[uri]) {
      result[uri].push(...edits);
    } else {
      result[uri] = edits;
    }
  }
  return result;
}

function getSourceDoc(fileName: string, program: ts.Program): TextDocument {
  const sourceFile = program.getSourceFile(fileName)!;
  return TextDocument.create(fileName, 'vue', 0, sourceFile.getFullText());
}

export function languageServiceIncludesFile(ls: ts.LanguageService, documentUri: string): boolean {
  const filePaths = ls.getProgram()!.getRootFileNames();
  const filePath = getFilePath(documentUri);
  return filePaths.includes(filePath);
}

function convertRange(document: TextDocument, span: ts.TextSpan): Range {
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + span.length);
  return Range.create(startPosition, endPosition);
}

function convertOptions(
  formatSettings: ts.FormatCodeSettings,
  options: FormattingOptions,
  initialIndentLevel: number
): ts.FormatCodeSettings {
  return _.assign(formatSettings, {
    convertTabsToSpaces: options.insertSpaces,
    tabSize: options.tabSize,
    indentSize: options.tabSize,
    baseIndentSize: options.tabSize * initialIndentLevel
  });
}

function getFormatCodeSettings(config: any): ts.FormatCodeSettings {
  return {
    tabSize: config.vetur.format.options.tabSize,
    indentSize: config.vetur.format.options.tabSize,
    convertTabsToSpaces: !config.vetur.format.options.useTabs,
    insertSpaceAfterCommaDelimiter: true
  };
}

function convertCodeAction(
  doc: TextDocument,
  codeActions: ts.CodeAction[],
  regionStart: LanguageModelCache<LanguageRange | undefined>
): TextEdit[] {
  const scriptStartOffset = doc.offsetAt(regionStart.refreshAndGet(doc)!.start);
  const textEdits: TextEdit[] = [];
  for (const action of codeActions) {
    for (const change of action.changes) {
      textEdits.push(
        ...change.textChanges.map(tc => {
          // currently, only import codeAction is available
          // change start of doc to start of script region
          if (tc.span.start <= scriptStartOffset && tc.span.length === 0) {
            const region = regionStart.refreshAndGet(doc);
            if (region) {
              const line = region.start.line;
              return {
                range: Range.create(line + 1, 0, line + 1, 0),
                newText: tc.newText
              };
            }
          }
          return {
            range: convertRange(doc, tc.span),
            newText: tc.newText
          };
        })
      );
    }
  }
  return textEdits;
}

function convertTSDiagnosticCategoryToDiagnosticSeverity(c: ts.DiagnosticCategory) {
  switch (c) {
    case ts.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Message:
      return DiagnosticSeverity.Information;
    case ts.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Hint;
  }
}
