import * as http from 'http'
import * as fs from 'fs'
import express from 'express'
import * as ejs from 'ejs'
import cors from 'cors'
import morgan from 'morgan'
import * as path from 'path'
import markdownit from './Markdown-it'
import { exportHTML, IExportOptions } from './ExportHTML'
import { Disposable } from './dispose'
import { RevealContext } from './RevealContext'
import { ISlide } from './ISlide'

const { spawnSync } = require('child_process')

/** Http server to serve reveal presentation */
export class RevealServer extends Disposable {

  public readonly app = express()

  private server: http.Server | null = null
  private readonly host = 'localhost'

  constructor(private readonly context: RevealContext) {
    super()
    this.configure()
  }


  /**
   * If the server is not listening, start the server and log the server's status.
   * @returns The uri of the server.
   */
  public start() {
    try {
      if (!this.isListening) {
        this.server = this.app.listen(0)
        this.context.logger.info(`SERVER started`)
      }
    } catch (err) {
      const error = new Error(`Cannot start server: ${err}`)
      this.context.logger.error(`SERVER: Cannot start server: ${err}`)
      throw error
    }
    return this.uri
  }

  /** True if server is currently listening*/
  public get isListening() {
    return this.server ? this.server.listening : false
  }

  /** Stop listening */
  public stop(): void {
    if (this.isListening && this.server) {
      this.server.close()
      this.context.logger.debug(`SERVER: stopped`)
    }
  }

  /** Current uri for this server, empty is not listening */
  public get uri() {
    if (!this.isListening || this.server === null) {
      return ""
    }

    const addr = this.server.address()
    if (typeof addr === 'string') {
      return addr
    }
    if (addr === null) {
      return ''
    }
    return `http://${this.host}:${addr.port}/`
  }

  /** The function configures the express app to serve the presentation */
  private configure() {
    const app = this.app
    const context = this.context



    //disable cache
    app.set('etag', false)
    app.use((req, res, next) => {
      res.set('Cache-Control', 'no-store')
      next()
    })

    // Set EJS as view
    app.set('view engine', 'ejs');
    app.engine('ejs', ejs.__express)
    app.set('views', path.resolve(context.extensionPath, 'views'));
    app.use(cors())
    // LOG REQUEST
    app.use(morgan(':method :url :status :res[content-length] - :response-time ms', { stream: { write: (str) => context.logger.info(str) } }))

    // EXPORT
    app.use(this.exportMiddleware(exportHTML, context.isInExport))

    // STATIC LIBS
    const libsPAth = path.join(context.extensionPath, 'libs')
    app.use('/libs', express.static(libsPAth, { cacheControl: false, etag: false, immutable: false }));

    // STATIC RELATIVE TO MD FILE if file is saved
    if (context.dirname) {
      app.use('/', express.static(context.dirname, { cacheControl: false, etag: false, immutable: false }));
    }

    // MAIN FILE
    app.use((req, res, next) => {
      if (req.path !== '/') {
        next()
      }
      else {

        let init: string | null = null;
        if (context.dirname) {
          const initPath = path.join(context.dirname, 'init.js')
          if (fs.existsSync(initPath)) {
            init = fs.readFileSync(initPath, "utf8");
          }
        }

        const rootDir = context.dirname;
        const rootDirEscaped = rootDir.replace(/\\/g, '\\\\');
        const lineOffset = (context.frontmatter?.frontmatter ? (context.frontmatter.bodyBegin - 1) : 0) - 2;
        const rootDirDefine = `@@$ const SLIDE_PARENT_DIRECTORY = '${rootDirEscaped}'; __mjsd_line(${lineOffset});`;

        const slideSeparator = "!$*$*$!";
        const allSlidesText = rootDirDefine + "\n\n" + context.slides.map(s => s.text).join(`\n${slideSeparator}\n`);
        const somethingChanged = context.forcedRefreshes > 0 || context.lastAllSlidesText !== allSlidesText

        if (context.forcedRefreshes > 0)
        {
          --context.forcedRefreshes;
        }

        context.lastAllSlidesText = allSlidesText;

        if (somethingChanged)
        {
          // Deep-copy each slide
          const newSlides: ISlide[] = context.slides.map(slide => ({ ...slide }));

          // TODO: make this path customizable via VSCode extension setting
          // TODO: `spawnSync` is the current performance bottleneck
          const proc = spawnSync('C:/OHW/majsdown/build/majsdown-converter.exe', [], { input: allSlidesText, encoding: 'utf-8' });
          const procStdErr = String(proc.output[2]);

          if (procStdErr != '' && procStdErr != null)
          {
            // TODO: print proc status
            newSlides.forEach(slide => slide.text = "``````text\n" + procStdErr + "\n``````\n");
          }
          else
          {
            const procStdOut = String(proc.output[1]);
            procStdOut.split(slideSeparator).forEach((elem, i) => { newSlides[i].text = elem; });
          }

          const htmlSlides = newSlides.map((s) => ({
            ...s,
            html: markdownit.render(s.text),
            children: s.verticalChildren.map((c) => ({ ...c, html: markdownit.render(c.text) })),
          }));

          context.lastHtmlSlides = htmlSlides;
        }

        res.render('index', { slides: context.lastHtmlSlides, ...context.configuration, rootUrl: this.uri, init });
      }
    })

    // ERROR HANDLER
    app.use(function (err, req, res, next) {
      context.logger.error(err.stack)
      res.status(500).send(err.stack);
    });
  }

  /* A middleware function that is used to export the presentation to a folder. */
  private readonly exportMiddleware = (exportfn: (ExportOptions) => Promise<void>, isInExport) => {

    const { exportPath } = this.context

    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {

      if (isInExport()) {

        console.log("in export");
        const oldWrite = res.write
        const oldEnd = res.end;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunks: any[] = [];

        res.write = (chunk, ...args) => {
          chunks.push(chunk);
          // @ts-ignore
          return oldWrite.apply(res, [chunk, ...args]);
        };
        // @ts-ignore
        res.end = async (chunk, ...args) => {
          this.context.logger.info(`${req.originalUrl.split('?')[0]} - ${chunks.length}`)
          if (chunk) {
            chunks.push(chunk);
          }
          try {
            let body = "";
            if (chunks.length > 0 && typeof chunks[0] === 'string') {
              body = body.concat(...(chunks as string[]));
            }
            else {
              body = Buffer.concat(chunks).toString('utf8');
            }


            const opts: IExportOptions = { folderPath: exportPath, url: req.originalUrl.split('?')[0], srcFilePath: null, data: body }
            await exportfn(opts);
          }
          catch (error) {
            this.context.logger.info(`Error : ${error}`)
          }

          // @ts-ignore
          return oldEnd.apply(res, [chunk, ...args]);
        };
      }
      next()


    }
  }

  dispose(): void {
    this.stop()
    this.server = null
    super.dispose();
  }
}
