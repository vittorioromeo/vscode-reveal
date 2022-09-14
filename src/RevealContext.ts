import { FrontMatterResult } from 'front-matter'
import path from 'path'
import { isDeepStrictEqual } from 'util'
import { EventEmitter, Position, Range, Selection, TextDocument, TextEditor, TextEditorRevealType, Uri } from 'vscode'
import { Configuration, mergeConfig } from './Configuration'
import { Disposable } from './dispose'
import { ISlide } from './ISlide'
import Logger from './Logger'
import { RevealServer } from './RevealServer'
import slideParser from './SlideParser'
import { countLinesToSlide } from './utils'

interface ISlidePosition {
  horizontal: number
  vertical: number
}

export class RevealContext extends Disposable {
  readonly #server: RevealServer

  public slides: ISlide[] = []
  public frontmatter?: FrontMatterResult<Configuration>
  public configuration: Configuration
  private position: ISlidePosition = { horizontal: 0, vertical: 0 }

  public lastAllSlidesText: string = ""
  public lastHtmlSlides: any = []
  public forcedRefreshes: number = 2
  public lastSlideIdx: number | null = null

  constructor(
    public editor: TextEditor,
    public logger: Logger,
    public getConfiguration: () => Configuration,
    public extensionPath: string,
    public isInExport: () => boolean
  ) {
    super()
    this.editor = editor
    this.configuration = getConfiguration()
    this.#server = new RevealServer(this)
    this._register(this.#server)
  }

  private get docUri() {
    return this.editor.document.uri
  }

  private getText(range?: Range) {
    return this.editor.document.getText(range)
  }

  public get dirname() {
    return path.dirname(this.editor.document.fileName)
  }

  get uriWithPosition() {
    const { horizontal, vertical } = this.position
    return `${this.#server.uri}#/${horizontal}/${vertical}/${Date.now()}`
  }

  get baseUri() {
    return this.#server.uri
  }

  public get exportPath(): string {
    return path.isAbsolute(this.configuration.exportHTMLPath)
      ? this.configuration.exportHTMLPath
      : path.join(this.dirname, this.configuration.exportHTMLPath)
  }

  public refresh() {
    const { frontmatter, slides } = slideParser.parse(this.getText(), this.configuration)
    this.slides = slides
    if (!isDeepStrictEqual(frontmatter, this.frontmatter)) {
      this.frontmatter = frontmatter
      this.configuration = mergeConfig(this.getConfiguration(), frontmatter.attributes)
      this.logger.LogLevel = this.configuration.logLevel
    }

    this.logger.debug(`CONTEXT: ${this.docUri} - Refreshed`)
    return { frontmatter, slides }
  }

  updatePosition(cursorPosition: Position): boolean {
    const start = new Position(0, 0)
    const range = new Range(start, cursorPosition)
    const { slides } = slideParser.parse(this.getText(range), this.configuration, false)
    const currentSlideIdx = slides.length - 1;
    const currentSlide = slides[currentSlideIdx]

    this.position = currentSlide.verticalChildren
      ? { horizontal: currentSlideIdx, vertical: currentSlide.verticalChildren.length }
      : { horizontal: currentSlideIdx, vertical: 0 }

    const changedSlide = this.lastSlideIdx !== currentSlideIdx;
    this.lastSlideIdx = currentSlideIdx;
    return changedSlide;
  }

  is(document: TextDocument) {
    return this.editor.document.uri == document.uri
  }

  goToSlide(topindex: number, verticalIndex: number) {
    const linesCount =
      countLinesToSlide(this.slides, topindex, verticalIndex) + (this.frontmatter?.frontmatter ? this.frontmatter.bodyBegin : 0)

    const position = new Position(linesCount, 0)
    this.editor.selection = new Selection(position, position) //selections = [new Selection(position, position)]
    this.editor.revealRange(new Range(position, position.translate(20)))
  }

  startServer() {
    return this.#server.start()
  }

  stopServer() {
    this.#server.stop()
  }

  private readonly _onDidDispose = this._register(new EventEmitter<void>())
  /**
   * Fired when the document is disposed of.
   */
  public readonly onDidDispose = this._onDidDispose.event

  /**
   * Called by VS Code when there are no more references to the document.
   *
   * This happens when all editors for it have been closed.
   */
  dispose(): void {
    this._onDidDispose.fire()
    super.dispose()
  }
}

export class RevealContexts {
  private readonly innerMap = new Map<Uri, RevealContext>()

  constructor(
    private readonly logger: Logger,
    private readonly getConfiguration: () => Configuration,
    private readonly extensionPath: string,
    private readonly isInExport: () => boolean
  ) {
    this.logger = logger
  }

  getOrAdd(editor: TextEditor) {
    if (this.innerMap.has(editor.document.uri)) return this.innerMap.get(editor.document.uri)
    const context = new RevealContext(editor, this.logger, this.getConfiguration, this.extensionPath, this.isInExport)

    context.onDidDispose(() => this.logger.info(`CONTEXT: ${editor.document.uri} disposed`))

    this.innerMap.set(editor.document.uri, context)
    return context
  }

  remove(uri) {
    const context = this.innerMap.get(uri)
    if (context) {
      this.innerMap.delete(uri)
      context.dispose()
    }
  }
}
