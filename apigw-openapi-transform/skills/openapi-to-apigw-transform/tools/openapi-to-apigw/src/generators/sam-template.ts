import YAML from 'yaml';
import type { SourceAnalysis, TransformOptions } from '../types.js';
import { needsLambdaAuthorizer, resolveOptions } from '../types.js';

function deriveApiName(analysis: SourceAnalysis): string {
  return analysis.fileName.replace(/\.(yaml|yml|json)$/i, '').replace(/-cleaned$/, '');
}

/**
 * Generate an AWS SAM template for deploying the API.
 *
 * Always uses DefinitionUri (external spec file). The cleaned spec contains
 * x-amazon-apigateway-authorizer extensions with literal placeholders
 * ({{AWS_REGION}}, {{AUTHORIZER_FUNCTION_ARN}}) that the deploy script
 * resolves before uploading the spec to S3.
 *
 * When the spec has authorizers, the Lambda authorizer function is embedded
 * in the same template. The deploy script uses a two-phase approach on a
 * single stack: first deploy the Lambda-only template, then retrieve the
 * ARN, resolve spec placeholders, and update the stack to add the API.
 */
export function generateSamTemplate(
  analysis: SourceAnalysis,
  options: TransformOptions,
): string {
  const resolved = resolveOptions(options);
  const apiName = deriveApiName(analysis);
  const hasAuthorizers = analysis.securitySchemes.some(needsLambdaAuthorizer);
  const format = resolved.format ?? 'yaml';
  const ext = format === 'json' ? 'json' : 'yaml';

  const template: Record<string, any> = {
    AWSTemplateFormatVersion: '2010-09-09',
    Transform: 'AWS::Serverless-2016-10-31',
    Description: `API Gateway REST API for ${apiName} (auto-generated via SAM). `
      + 'X-Ray tracing is enabled. Access logging is NOT configured: API Gateway REST APIs '
      + 'can only deliver access logs after a CloudWatch Logs role ARN is set once per region '
      + 'at the account level (Account.cloudWatchRoleArn), so enabling it here would break the '
      + 'deploy in an unprepared account. Set that role, then add AccessLogSetting to the stage.',
    Globals: {
      Api: {
        OpenApiVersion: '3.0.0',
      },
    },
    Parameters: {
      StageName: {
        Type: 'String',
        Default: resolved.stage,
        Description: 'API Gateway stage name',
      },
    },
    Resources: {},
    Outputs: {},
  };

  if (hasAuthorizers) {
    const runtime = resolved.runtime;

    // Embed the authorizer Lambda in this template
    template.Resources.AuthorizerFunction = {
      Type: 'AWS::Serverless::Function',
      Properties: {
        FunctionName: { 'Fn::Sub': `\${AWS::StackName}-auth-fn` },
        Runtime: runtime,
        Handler: 'index.handler',
        InlineCode: getAuthorizerCode(runtime),
        Timeout: 30,
        Tracing: 'Active',
      },
    };

    // Grant API Gateway invoke permission
    template.Resources.AuthorizerPermission = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: { 'Fn::GetAtt': ['AuthorizerFunction', 'Arn'] },
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: { 'Fn::Sub': 'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${RestApi}/*' },
      },
    };

    template.Outputs.AuthorizerFunctionArn = {
      Description: 'ARN of the Lambda authorizer function',
      Value: { 'Fn::GetAtt': ['AuthorizerFunction', 'Arn'] },
    };
  }

  const apiProperties: Record<string, any> = {
    Name: { 'Fn::Sub': `\${AWS::StackName}-api` },
    Description: `REST API for ${apiName}`,
    StageName: { Ref: 'StageName' },
    FailOnWarnings: false,
    // X-Ray tracing needs no account-level setup, so it is on by default.
    // Access logging is intentionally NOT set here — see the template Description.
    TracingEnabled: true,
    DefinitionUri: `./${apiName}-cleaned.${ext}`,
  };

  template.Resources.RestApi = {
    Type: 'AWS::Serverless::Api',
    Properties: apiProperties,
  };

  template.Outputs.RestApiId = {
    Description: 'REST API ID',
    Value: { Ref: 'RestApi' },
  };
  template.Outputs.InvokeURL = {
    Description: 'API invoke URL',
    Value: { 'Fn::Sub': 'https://${RestApi}.execute-api.${AWS::Region}.amazonaws.com/${StageName}' },
  };

  return YAML.stringify(template, { lineWidth: 0 });
}

/**
 * Generate a SAM template for deploying ONLY the Lambda authorizer.
 *
 * This is the "phase 1" template used for two-phase single-stack deployment.
 * The deploy script first deploys this template under the same stack name to
 * create the Lambda function, retrieves its ARN, resolves spec placeholders,
 * then updates the stack with the full template (from generateSamTemplate)
 * which includes both the Lambda and the API.
 *
 * Returns null if the spec has no security schemes needing a Lambda authorizer.
 */
export function generateAuthorizerTemplate(
  analysis: SourceAnalysis,
  options: TransformOptions,
): string | null {
  const hasAuthorizers = analysis.securitySchemes.some(needsLambdaAuthorizer);
  if (!hasAuthorizers) return null;

  const resolved = resolveOptions(options);
  const runtime = resolved.runtime;

  const template: Record<string, any> = {
    AWSTemplateFormatVersion: '2010-09-09',
    Transform: 'AWS::Serverless-2016-10-31',
    Description: `Lambda authorizer (phase 1) — will be updated to include API (auto-generated via SAM)`,
    Resources: {
      AuthorizerFunction: {
        Type: 'AWS::Serverless::Function',
        Properties: {
          FunctionName: { 'Fn::Sub': `\${AWS::StackName}-auth-fn` },
          Runtime: runtime,
          Handler: 'index.handler',
          InlineCode: getAuthorizerCode(runtime),
          Timeout: 30,
          Tracing: 'Active',
        },
      },
    },
    Outputs: {
      AuthorizerFunctionArn: {
        Description: 'ARN of the Lambda authorizer function',
        Value: { 'Fn::GetAtt': ['AuthorizerFunction', 'Arn'] },
      },
    },
  };

  return YAML.stringify(template, { lineWidth: 0 });
}

function getAuthorizerCode(runtime: string): string {
  if (runtime.startsWith('python')) {
    return `
def handler(event, context):
    # Default deny-all authorizer — replace with real auth logic
    return {
        "principalId": "user",
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [{
                "Action": "execute-api:Invoke",
                "Effect": "Deny",
                "Resource": event.get("methodArn", "*")
            }]
        }
    }
`.trim();
  }

  return `
exports.handler = async (event) => {
  // Default deny-all authorizer — replace with real auth logic
  return {
    principalId: "user",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Action: "execute-api:Invoke",
        Effect: "Deny",
        Resource: event.methodArn || "*"
      }]
    }
  };
};
`.trim();
}
