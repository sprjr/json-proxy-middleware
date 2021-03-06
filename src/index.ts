import bunyan from 'bunyan';
import { Request, RequestHandler, Response } from 'express';
import _pick from 'lodash/pick';
import request, { CoreOptions, Headers, UrlOptions } from 'request';
import { inspect } from 'util';
import VError from 'verror';

export type UrlHost = string | ((req: Request, res: Response) => string);
export type HeaderOption = object | ((req: Request, res: Response) => request.Headers);
export type AddCurlHeader = boolean | ((req: Request, res: Response) => boolean);
export type LoggerOption =
  | bunyan
  | Console
  | {
      info(message?: any, ...optionalParams: any[]): void;
      error(message?: any, ...optionalParams: any[]): void;
    };

export interface ProxyMiddlewareOptions {
  additionalLogMessage: string;
  headers: HeaderOption;
  urlHost: UrlHost;
  addCurlHeader?: AddCurlHeader;
  logger?: LoggerOption;
}

interface AgentOptionsRequest extends Request {
  agentOptions?: any;
}

// we use these for more accurate timing when logging
const NS_PER_SEC: number = 1e9;
const MS_PER_NS: number = 1e6;
const TRUNCATED = '...<truncated due to header size>';

// by default, we intend to proxy only json responses
const defaultHeaders: object = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

/**
 * None of our backends require these headers for their curl requests.
 */
const curlOmitHeaders = new Set([
  'content-security-policy',
  'x-dns-prefetch-control',
  'x-frame-options',
  'referer',
  'accept-language',
  'accept-encoding',
  'pragma',
  'cache-control',
  'host',
  'connection',
]);

const createCurlRequest = (requestOptions: request.CoreOptions & request.UrlOptions) => {
  const requestHeaders = (requestOptions.headers || {});
  const headers = Object.keys((requestOptions.headers || {})).reduce((headersString, headerKey) => {
    if (!curlOmitHeaders.has(headerKey)) {
      return `${headersString}-H '${headerKey}: ${requestHeaders[headerKey]}' `;
    }
    return headersString;
  }, '');
  const requestBody = JSON.stringify(requestOptions.body || {});
  return `'${requestOptions.url}' -X ${requestOptions.method} ${headers} -d ${requestBody}`;
};

/**
 * As of node 10.14.0, the max header size was reduced to 8kb, which
 * means the character length of the headers object must be less than
 * 8000 characters. Rather than precisely measure which would be somewhat
 * expensive, we conservatively allow 4000 characters.
 * https://nodejs.org/api/cli.html#cli_max_http_header_size_size
 */
const maxHeaderSize = 4000;

// This middleware proxies requests through Node to a backend service.
// You _must_ register bodyParser.json() before mounting this middleware. Also,
// it only works for JSON bodies (and not, for instance, form encoded bodies,
// or bodies with YAML, or anything else like that).
export default (options: ProxyMiddlewareOptions): RequestHandler => (req, res, next) => {
  const { logger, additionalLogMessage, addCurlHeader = false } = options;
  const canLogError = logger && logger.error && typeof logger.error === 'function';
  const host = typeof options.urlHost === 'function' ? options.urlHost(req, res) : options.urlHost;
  const urlPath = req.originalUrl.replace(req.baseUrl, '');

  if (typeof host !== 'string') {
    if (canLogError) {
      let fullMsg = 'Proxy Error: PROXY_HOST_ERROR';
      if (additionalLogMessage) {
        fullMsg += ` ${additionalLogMessage}`;
      }
      logger!.error(
        {
          host,
          urlPath,
          url: `${host}${urlPath}`,
        },
        fullMsg,
      );
    }

    next(
      new VError(
        {
          name: 'PROXY_HOST_ERROR',
          info: {
            detail:
              `The options.urlHost provided either was not a string, or the value` +
              `returned from invoking urlHost() was not a string.`,
            meta: {
              additionalLogMessage: additionalLogMessage || '',
              body: req.body,
            },
          },
        },
        '`urlHost` could not be resolved to a valid string.',
      ),
    );
    return;
  }

  const canLogInfo = logger && logger.info && typeof logger.info === 'function';
  const headers: Headers = {
    ...defaultHeaders,
    ...(typeof options.headers === 'function' ? options.headers(req, res) : options.headers || {}),
  };

  if (canLogInfo) {
    let fullMsg = 'Proxy start.';
    if (additionalLogMessage) {
      fullMsg += ` ${additionalLogMessage}`;
    }
    logger!.info(
      {
        host,
        urlPath,
        headers,
        url: `${host}${urlPath}`,
        body: inspect(req.body, { maxArrayLength: 20 }),
      },
      fullMsg,
    );
  }

  const startTime = process.hrtime();
  const requestOptions: CoreOptions & UrlOptions = {
    ...(req as AgentOptionsRequest).agentOptions, // https://github.com/request/request/issues/2964
    method: req.method,
    headers,
    url: `${host}${urlPath}`,
    body: JSON.stringify(req.body),
  };
  const requestStream = request(requestOptions);

  // If desired, set the curl header in the response headers so the client can surface it for
  // debugging purposes.
  const shouldAddCurlHeader = addCurlHeader && typeof addCurlHeader === 'function'
    ? addCurlHeader(req, res)
    : addCurlHeader;

  // Encode the curl command header to ensure it doesn't have invalid characters, otherwise
  // request will throw an exception: https://github.com/request/request/issues/2120
  const curlCommand = shouldAddCurlHeader && encodeURI(createCurlRequest(requestOptions));
  if (curlCommand) {
    res.setHeader('x-curl-command', curlCommand.length < maxHeaderSize
      ? curlCommand
      : `${curlCommand.slice(0, maxHeaderSize - TRUNCATED.length)}${TRUNCATED}`);
  }

  requestStream.on('error', err => {
    if (canLogError) {
      let fullMsg = 'Proxy Error: PROXY_REQUEST_ERROR';
      if (additionalLogMessage) {
        fullMsg += ` ${additionalLogMessage}`;
      }
      logger!.error(
        {
          host,
          urlPath,
          url: `${host}${urlPath}`,
        },
        fullMsg,
      );
    }

    next(
      new VError(
        {
          name: 'PROXY_REQUEST_ERROR',
          cause: err,
          info: {
            detail: `The proxied path is ${urlPath}. The host is ${host}.`,
            meta: {
              additionalLogMessage: additionalLogMessage || '',
              url: `${host}${urlPath}`,
              body: req.body,
            },
          },
        },
        'There was an error while making the proxied request.',
      ),
    );
    return;
  });

  const responseStream = requestStream.pipe(res);
  responseStream.on('error', err => {
    if (canLogError) {
      let fullMsg = 'Proxy Error: PROXY_RESPONSE_ERROR';
      if (additionalLogMessage) {
        fullMsg += ` ${additionalLogMessage}`;
      }
      logger!.error(
        {
          host,
          urlPath,
          url: `${host}${urlPath}`,
        },
        fullMsg,
      );
    }

    next(
      new VError(
        {
          name: 'PROXY_RESPONSE_ERROR',
          cause: err,
          info: {
            detail: `The proxied path is ${urlPath}. The host is ${host}.`,
            meta: {
              additionalLogMessage: additionalLogMessage || '',
              url: `${host}${urlPath}`,
              body: req.body,
            },
          },
        },
        'There was an error while streaming the response.',
      ),
    );
    return;
  });

  responseStream.on('finish', () => {
    if (canLogInfo) {
      let fullMsg = 'Proxy end.';
      if (additionalLogMessage) {
        fullMsg += ` ${additionalLogMessage}`;
      }
      const diffTime = process.hrtime(startTime);
      const nanoseconds = diffTime[0] * NS_PER_SEC + diffTime[1];
      const milliseconds = nanoseconds / MS_PER_NS;
      const duration = `${milliseconds} ms`;
      logger!.info({ host, urlPath, duration }, fullMsg);
    }
  });
};
