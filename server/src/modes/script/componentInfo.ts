import * as ts from 'typescript';
import {
  VueFileInfo,
  PropInfo,
  ComputedInfo,
  DataInfo,
  MethodInfo,
  ChildComponent
} from '../../services/vueInfoService';
import { getChildComponents } from './childComponents';
import { T_TypeScript } from '../../services/dependencyService';

export function getComponentInfo(
  tsModule: T_TypeScript,
  service: ts.LanguageService,
  fileFsPath: string,
  config: any
): VueFileInfo | undefined {
  const program = service.getProgram();
  if (!program) {
    return undefined;
  }

  const sourceFile = program.getSourceFile(fileFsPath);
  if (!sourceFile) {
    return undefined;
  }

  const checker = program.getTypeChecker();

  const defaultExportNode = getDefaultExportNode(tsModule, sourceFile);
  if (!defaultExportNode) {
    return undefined;
  }

  const vueFileInfo = analyzeDefaultExportExpr(tsModule, defaultExportNode, checker);

  const defaultExportType = checker.getTypeAtLocation(defaultExportNode);
  const internalChildComponents = getChildComponents(
    tsModule,
    defaultExportType,
    checker,
    config.vetur.completion.tagCasing
  );

  if (internalChildComponents) {
    const childComponents: ChildComponent[] = [];
    internalChildComponents.forEach(c => {
      childComponents.push({
        name: c.name,
        documentation: c.documentation,
        definition: c.definition,
        info: c.defaultExportNode ? analyzeDefaultExportExpr(tsModule, c.defaultExportNode, checker) : undefined
      });
    });
    vueFileInfo.componentInfo.childComponents = childComponents;
  }

  return vueFileInfo;
}

export function analyzeDefaultExportExpr(
  tsModule: T_TypeScript,
  defaultExport: ts.Node,
  checker: ts.TypeChecker
): VueFileInfo {
  const defaultExportType = checker.getTypeAtLocation(defaultExport);

  const props = getProps(tsModule, defaultExportType, checker);
  const data = getData(tsModule, defaultExportType, checker);
  const computed = getComputed(tsModule, defaultExportType, checker);
  const methods = getMethods(tsModule, defaultExportType, checker);

  return {
    componentInfo: {
      props,
      data,
      computed,
      methods
    }
  };
}

export function getDefaultExportNode(tsModule: T_TypeScript, sourceFile: ts.SourceFile): ts.Node | undefined {
  const exportStmts = sourceFile.statements.filter(
    st => st.kind === tsModule.SyntaxKind.ExportAssignment || st.kind === tsModule.SyntaxKind.ClassDeclaration
  );
  if (exportStmts.length === 0) {
    return undefined;
  }
  const exportNode =
    exportStmts[0].kind === tsModule.SyntaxKind.ExportAssignment
      ? (exportStmts[0] as ts.ExportAssignment).expression
      : (exportStmts[0] as ts.ClassDeclaration);

  return getNodeFromExportNode(tsModule, exportNode);
}

function getProps(tsModule: T_TypeScript, defaultExportType: ts.Type, checker: ts.TypeChecker): PropInfo[] | undefined {
  const result: PropInfo[] = getClassAndObjectInfo(tsModule, defaultExportType, checker, getClassProps, getObjectProps);

  function getClassProps(type: ts.Type) {
    const propDecoratorNames = ['Prop', 'Model', 'PropSync'];
    const propsSymbols = type
      .getProperties()
      .filter(property =>
        getPropertyDecoratorNames(tsModule, property, tsModule.SyntaxKind.PropertyDeclaration).some(decoratorName =>
          propDecoratorNames.includes(decoratorName)
        )
      );
    if (propsSymbols.length === 0) {
      return undefined;
    }

    return propsSymbols.map(prop => {
      return {
        name: prop.name,
        documentation: buildDocumentation(tsModule, prop, checker)
      };
    });
  }

  function getObjectProps(type: ts.Type) {
    const propsSymbol = checker.getPropertyOfType(type, 'props');
    if (!propsSymbol || !propsSymbol.valueDeclaration) {
      return undefined;
    }

    const propsDeclaration = getLastChild(propsSymbol.valueDeclaration);
    if (!propsDeclaration) {
      return undefined;
    }

    /**
     * Plain array props like `props: ['foo', 'bar']`
     */
    if (propsDeclaration.kind === tsModule.SyntaxKind.ArrayLiteralExpression) {
      return (propsDeclaration as ts.ArrayLiteralExpression).elements
        .filter(expr => expr.kind === tsModule.SyntaxKind.StringLiteral)
        .map(expr => {
          return {
            name: (expr as ts.StringLiteral).text
          };
        });
    }

    /**
     * Object literal props like
     * ```
     * {
     *   props: {
     *     foo: { type: Boolean, default: true },
     *     bar: { type: String, default: 'bar' }
     *   }
     * }
     * ```
     */
    if (propsDeclaration.kind === tsModule.SyntaxKind.ObjectLiteralExpression) {
      const propsType = checker.getTypeOfSymbolAtLocation(propsSymbol, propsDeclaration);

      return checker.getPropertiesOfType(propsType).map(s => {
        return {
          name: s.name,
          documentation: buildDocumentation(tsModule, s, checker)
        };
      });
    }

    return undefined;
  }

  return result.length === 0 ? undefined : result;
}

/**
 * In SFC, data can only be a function
 * ```
 * {
 *   data() {
 *     return {
 *        foo: true,
 *        bar: 'bar'
 *     }
 *   }
 * }
 * ```
 */
function getData(tsModule: T_TypeScript, defaultExportType: ts.Type, checker: ts.TypeChecker): DataInfo[] | undefined {
  const result: DataInfo[] = getClassAndObjectInfo(tsModule, defaultExportType, checker, getClassData, getObjectData);

  function getClassData(type: ts.Type) {
    const noDataDecoratorNames = ['Prop', 'Model', 'Provide', 'ProvideReactive', 'Ref'];
    const dataSymbols = type
      .getProperties()
      .filter(
        property =>
          !getPropertyDecoratorNames(tsModule, property, tsModule.SyntaxKind.PropertyDeclaration).some(decoratorName =>
            noDataDecoratorNames.includes(decoratorName)
          ) &&
          !property.name.startsWith('_') &&
          !property.name.startsWith('$')
      );
    if (dataSymbols.length === 0) {
      return undefined;
    }

    return dataSymbols.map(data => {
      return {
        name: data.name,
        documentation: buildDocumentation(tsModule, data, checker)
      };
    });
  }

  function getObjectData(type: ts.Type) {
    const dataSymbol = checker.getPropertyOfType(type, 'data');
    if (!dataSymbol || !dataSymbol.valueDeclaration) {
      return undefined;
    }

    const dataType = checker.getTypeOfSymbolAtLocation(dataSymbol, dataSymbol.valueDeclaration);
    const dataSignatures = dataType.getCallSignatures();
    if (dataSignatures.length === 0) {
      return undefined;
    }
    const dataReturnTypeProperties = checker.getReturnTypeOfSignature(dataSignatures[0]);
    return dataReturnTypeProperties.getProperties().map(s => {
      return {
        name: s.name,
        documentation: buildDocumentation(tsModule, s, checker)
      };
    });
  }

  return result.length === 0 ? undefined : result;
}

function getComputed(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker
): ComputedInfo[] | undefined {
  const result: ComputedInfo[] = getClassAndObjectInfo(
    tsModule,
    defaultExportType,
    checker,
    getClassComputed,
    getObjectComputed
  );

  function getClassComputed(type: ts.Type) {
    const getAccessorSymbols = type
      .getProperties()
      .filter(property => property.valueDeclaration.kind === tsModule.SyntaxKind.GetAccessor);
    const setAccessorSymbols = defaultExportType
      .getProperties()
      .filter(property => property.valueDeclaration.kind === tsModule.SyntaxKind.SetAccessor);
    if (getAccessorSymbols.length === 0) {
      return undefined;
    }

    return getAccessorSymbols.map(computed => {
      const setComputed = setAccessorSymbols.find(setAccessor => setAccessor.name === computed.name);
      return {
        name: computed.name,
        documentation:
          buildDocumentation(tsModule, computed, checker) +
          (setComputed !== undefined ? buildDocumentation(tsModule, setComputed, checker) : '')
      };
    });
  }

  function getObjectComputed(type: ts.Type) {
    const computedSymbol = checker.getPropertyOfType(type, 'computed');
    if (!computedSymbol || !computedSymbol.valueDeclaration) {
      return undefined;
    }

    const computedDeclaration = getLastChild(computedSymbol.valueDeclaration);
    if (!computedDeclaration) {
      return undefined;
    }

    if (computedDeclaration.kind === tsModule.SyntaxKind.ObjectLiteralExpression) {
      const computedType = checker.getTypeOfSymbolAtLocation(computedSymbol, computedDeclaration);

      return checker.getPropertiesOfType(computedType).map(s => {
        return {
          name: s.name,
          documentation: buildDocumentation(tsModule, s, checker)
        };
      });
    }
  }

  return result.length === 0 ? undefined : result;
}

function isInternalHook(methodName: string) {
  const $internalHooks = [
    'data',
    'beforeCreate',
    'created',
    'beforeMount',
    'mounted',
    'beforeDestroy',
    'destroyed',
    'beforeUpdate',
    'updated',
    'activated',
    'deactivated',
    'render',
    'errorCaptured', // 2.5
    'serverPrefetch' // 2.6
  ];
  return $internalHooks.includes(methodName);
}

function getMethods(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker
): MethodInfo[] | undefined {
  const result: MethodInfo[] = getClassAndObjectInfo(
    tsModule,
    defaultExportType,
    checker,
    getClassMethods,
    getObjectMethods
  );

  function getClassMethods(type: ts.Type) {
    const methodSymbols = type
      .getProperties()
      .filter(
        property =>
          !getPropertyDecoratorNames(tsModule, property, tsModule.SyntaxKind.MethodDeclaration).some(
            decoratorName => decoratorName === 'Watch'
          ) && !isInternalHook(property.name)
      );
    if (methodSymbols.length === 0) {
      return undefined;
    }

    return methodSymbols.map(method => {
      return {
        name: method.name,
        documentation: buildDocumentation(tsModule, method, checker)
      };
    });
  }

  function getObjectMethods(type: ts.Type) {
    const methodsSymbol = checker.getPropertyOfType(type, 'methods');
    if (!methodsSymbol || !methodsSymbol.valueDeclaration) {
      return undefined;
    }

    const methodsDeclaration = getLastChild(methodsSymbol.valueDeclaration);
    if (!methodsDeclaration) {
      return undefined;
    }

    if (methodsDeclaration.kind === tsModule.SyntaxKind.ObjectLiteralExpression) {
      const methodsType = checker.getTypeOfSymbolAtLocation(methodsSymbol, methodsDeclaration);

      return checker.getPropertiesOfType(methodsType).map(s => {
        return {
          name: s.name,
          documentation: buildDocumentation(tsModule, s, checker)
        };
      });
    }
  }

  return result.length === 0 ? undefined : result;
}

export function getNodeFromExportNode(tsModule: T_TypeScript, exportExpr: ts.Node): ts.Node | undefined {
  switch (exportExpr.kind) {
    case tsModule.SyntaxKind.CallExpression:
      // Vue.extend or synthetic __vueEditorBridge
      return (exportExpr as ts.CallExpression).arguments[0];
    case tsModule.SyntaxKind.ObjectLiteralExpression:
      return exportExpr as ts.ObjectLiteralExpression;
    case tsModule.SyntaxKind.ClassDeclaration:
      return exportExpr as ts.ClassDeclaration;
  }
  return undefined;
}

export function getLastChild(d: ts.Declaration) {
  const children = d.getChildren();
  if (children.length === 0) {
    return undefined;
  }

  return children[children.length - 1];
}

export function isClassType(tsModule: T_TypeScript, type: ts.Type) {
  if (type.isClass === undefined) {
    return !!(
      (type.flags & tsModule.TypeFlags.Object ? (type as ts.ObjectType).objectFlags : 0) & tsModule.ObjectFlags.Class
    );
  } else {
    return type.isClass();
  }
}

export function getComponentDecoratorArgumentType(tsModule: T_TypeScript, type: ts.Type, checker: ts.TypeChecker) {
  const decorators = type.symbol.declarations[0].decorators;
  if (!decorators || decorators.length === 0) {
    return undefined;
  }

  const componentDecorator = decorators.find(el => {
    const decoratorName = tsModule.isCallExpression(el.expression)
      ? el.expression.expression.getText()
      : el.expression.getText();
    return decoratorName === 'Component';
  });

  if (!componentDecorator || !tsModule.isCallExpression(componentDecorator.expression)) {
    return undefined;
  }

  const decoratorArguments = componentDecorator.expression.arguments;
  if (!decoratorArguments || decoratorArguments.length === 0) {
    return undefined;
  }

  return checker.getTypeAtLocation(decoratorArguments[0]);
}

function getClassAndObjectInfo<C, O>(
  tsModule: T_TypeScript,
  defaultExportType: ts.Type,
  checker: ts.TypeChecker,
  getClassResult: (type: ts.Type) => C[] | undefined,
  getObjectResult: (type: ts.Type) => O[] | undefined
) {
  const result: Array<C | O> = [];
  if (isClassType(tsModule, defaultExportType)) {
    result.push.apply(result, getClassResult(defaultExportType) || []);
    const decoratorArgumentType = getComponentDecoratorArgumentType(tsModule, defaultExportType, checker);
    if (decoratorArgumentType) {
      result.push.apply(result, getObjectResult(decoratorArgumentType) || []);
    }
  } else {
    result.push.apply(result, getObjectResult(defaultExportType) || []);
  }
  return result;
}

function getPropertyDecoratorNames(
  tsModule: T_TypeScript,
  property: ts.Symbol,
  checkSyntaxKind: ts.SyntaxKind
): string[] {
  if (property.valueDeclaration.kind !== checkSyntaxKind) {
    return [];
  }

  if (property.declarations.length === 0) {
    return [];
  }

  const decorators = property.declarations[0].decorators;
  if (decorators === undefined) {
    return [];
  }

  return decorators.map(decorator => {
    if (tsModule.isCallExpression(decorator.expression)) {
      return decorator.expression.expression.getText();
    } else {
      return decorator.expression.getText();
    }
  });
}

export function buildDocumentation(tsModule: T_TypeScript, s: ts.Symbol, checker: ts.TypeChecker) {
  let documentation = s
    .getDocumentationComment(checker)
    .map(d => d.text)
    .join('\n');

  documentation += '\n';

  if (s.valueDeclaration) {
    if (s.valueDeclaration.kind === tsModule.SyntaxKind.PropertyAssignment) {
      documentation += `\`\`\`js\n${formatJSLikeDocumentation(s.valueDeclaration.getText())}\n\`\`\`\n`;
    } else {
      documentation += `\`\`\`js\n${formatJSLikeDocumentation(s.valueDeclaration.getText())}\n\`\`\`\n`;
    }
  }
  return documentation;
}

function formatJSLikeDocumentation(src: string): string {
  const segments = src.split('\n');
  if (segments.length === 1) {
    return src;
  }

  const spacesToDeindent = segments[segments.length - 1].search(/\S/);

  return (
    segments[0] +
    '\n' +
    segments
      .slice(1)
      .map(s => s.slice(spacesToDeindent))
      .join('\n')
  );
}
