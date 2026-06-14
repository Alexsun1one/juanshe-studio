"use client"

import * as React from "react"
import {
  Copy,
  FileInput,
  Loader2,
  Play,
  RefreshCw,
  Save,
  ScanSearch,
  Tags,
  Trash2,
  Wand2,
} from "lucide-react"

import { fetchBooks } from "@/lib/api/client"
import { ENDPOINTS, type BookSummary } from "@/lib/api/types"
import { pickPreferredBook } from "@/lib/workspace-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { EmptyArt } from "@/components/design/cj-placeholder"
import "./capability-workbench.css"

type WorkbenchTab = "genres" | "import" | "detect"
type DetectConfirmAction = "chapter" | "all"
type MutationConfirmAction =
  | "genres:create"
  | "genres:save"
  | "genres:copy"
  | "import:text"
  | "import:url"
  | "import:style"
  | "import:book-style"
  | "import:sync"
type JsonRecord = Record<string, unknown>
type LoadState = "loading" | "ready" | "error"

type GenreDraft = {
  id: string
  name: string
  language: string
  pacingRule: string
}

type NewGenreDraft = {
  id: string
  name: string
  language: string
}

export function CapabilityWorkbench({
  initialTab = "genres",
}: {
  initialTab?: WorkbenchTab
}) {
  const { toast } = useToast()
  const [tab, setTab] = React.useState<WorkbenchTab>(initialTab)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [books, setBooks] = React.useState<BookSummary[]>([])
  const [booksState, setBooksState] = React.useState<LoadState>("loading")
  const [selectedBookId, setSelectedBookId] = React.useState("")

  const [genres, setGenres] = React.useState<unknown[]>([])
  const [genresState, setGenresState] = React.useState<LoadState>("loading")
  const [selectedGenreId, setSelectedGenreId] = React.useState("")
  const [genreDraft, setGenreDraft] = React.useState<GenreDraft>({
    id: "",
    name: "",
    language: "zh",
    pacingRule: "",
  })
  const [newGenre, setNewGenre] = React.useState<NewGenreDraft>({
    id: "",
    name: "",
    language: "zh",
  })
  const newGenreNameRef = React.useRef<HTMLInputElement>(null)
  const [genreBody, setGenreBody] = React.useState("")
  const [genreResult, setGenreResult] = React.useState<unknown>(null)
  const [deleteGenreId, setDeleteGenreId] = React.useState<string | null>(null)
  const [mutationConfirmAction, setMutationConfirmAction] =
    React.useState<MutationConfirmAction | null>(null)

  const [referenceTitle, setReferenceTitle] = React.useState("")
  const [referenceText, setReferenceText] = React.useState("")
  const [referenceUrl, setReferenceUrl] = React.useState("")
  const [styleSource, setStyleSource] = React.useState("")
  const [styleText, setStyleText] = React.useState("")
  const [analyses, setAnalyses] = React.useState<unknown[]>([])
  const [analysesState, setAnalysesState] = React.useState<LoadState>("loading")
  const [importResult, setImportResult] = React.useState<unknown>(null)

  const [chapterNum, setChapterNum] = React.useState("1")
  const [detectResult, setDetectResult] = React.useState<unknown>(null)
  const [detectStats, setDetectStats] = React.useState<unknown>(null)
  const [detectConfirmAction, setDetectConfirmAction] =
    React.useState<DetectConfirmAction | null>(null)

  React.useEffect(() => {
    void loadBooks()
    void loadGenres()
    void loadAnalyses()
  }, [])

  async function loadBooks() {
    setBooksState("loading")
    try {
      const rows = await fetchBooks()
      setBooks(rows)
      setBooksState("ready")
      if (!selectedBookId && rows.length > 0) {
        const preferredBook = preferredWorkbenchBook(rows, initialTab)
        if (preferredBook) {
          setSelectedBookId(preferredBook.id)
          setChapterNum(String(defaultDetectChapter(preferredBook)))
        }
      }
    } catch (error) {
      setBooksState("error")
      toast({
        title: "作品列表读取失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    }
  }

  function selectBook(id: string) {
    setSelectedBookId(id)
    const book = books.find((row) => row.id === id)
    if (book) setChapterNum(String(defaultDetectChapter(book)))
  }

  async function loadGenres(selectId?: string) {
    setGenresState("loading")
    setBusy("genres:load")
    try {
      const data = await requestJSON<unknown>(ENDPOINTS.genres())
      const rows = pickArray(data, ["genres", "items"])
      setGenres(rows)
      setGenresState("ready")
      const nextId = selectId || selectedGenreId || firstGenreId(rows)
      if (nextId) {
        setSelectedGenreId(nextId)
        await loadGenreDetail(nextId)
      } else {
        setSelectedGenreId("")
        setGenreDraft({ id: "", name: "", language: "zh", pacingRule: "" })
        setGenreBody("")
      }
    } catch (error) {
      setGenresState("error")
      toast({
        title: "题材库读取失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function loadGenreDetail(id = selectedGenreId) {
    if (!id) return
    setBusy("genres:detail")
    try {
      const data = await requestJSON<unknown>(ENDPOINTS.genre(id))
      const record = toRecord(data)
      const profile = toRecord(record?.profile) ?? record ?? {}
      const body = typeof record?.body === "string" ? record.body : ""
      setGenreDraft({
        id: stringField(profile.id) || id,
        name: stringField(profile.name) || id,
        language: stringField(profile.language) || "zh",
        pacingRule: stringField(profile.pacingRule),
      })
      setGenreBody(body)
      setGenreResult(data)
    } catch (error) {
      toast({
        title: "题材详情读取失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestCreateGenre(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newGenre.name.trim()
    if (!name) return
    setMutationConfirmAction("genres:create")
  }

  async function createGenre() {
    const name = newGenre.name.trim()
    if (!name) return
    const id = (newGenre.id.trim() || slugify(name)).slice(0, 80)
    setBusy("genres:create")
    try {
      const result = await requestJSON(ENDPOINTS.genres(), {
        method: "POST",
        body: JSON.stringify({
          id,
          name,
          language: newGenre.language.trim() || "zh",
          body: defaultGenreBody(name),
        }),
      })
      setNewGenre({ id: "", name: "", language: "zh" })
      setGenreResult(result)
      toast({ title: `已创建题材：${name}` })
      await loadGenres(id)
    } catch (error) {
      toast({
        title: "创建题材失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestSaveGenre(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = genreDraft.id.trim() || selectedGenreId
    if (!id) return
    setMutationConfirmAction("genres:save")
  }

  async function saveGenre() {
    const id = genreDraft.id.trim() || selectedGenreId
    if (!id) return
    setBusy("genres:save")
    try {
      const result = await requestJSON(ENDPOINTS.genre(id), {
        method: "PUT",
        body: JSON.stringify({
          profile: {
            id,
            name: genreDraft.name.trim() || id,
            language: genreDraft.language.trim() || "zh",
            pacingRule: genreDraft.pacingRule.trim(),
          },
          body: genreBody,
        }),
      })
      setGenreResult(result)
      toast({ title: "题材已保存" })
      await loadGenres(id)
    } catch (error) {
      toast({
        title: "保存题材失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestCopyGenre() {
    if (!selectedGenreId) return
    setMutationConfirmAction("genres:copy")
  }

  async function copyGenre() {
    if (!selectedGenreId) return
    setBusy("genres:copy")
    try {
      const result = await requestJSON(ENDPOINTS.genreCopy(selectedGenreId), {
        method: "POST",
        body: JSON.stringify({}),
      })
      setGenreResult(result)
      toast({ title: "题材模板已复制" })
    } catch (error) {
      toast({
        title: "复制题材失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestDeleteGenre() {
    if (!selectedGenreId) return
    setDeleteGenreId(selectedGenreId)
  }

  async function confirmDeleteGenre() {
    const id = deleteGenreId
    if (!id) return
    setBusy("genres:delete")
    try {
      const result = await requestJSON(ENDPOINTS.genre(id), {
        method: "DELETE",
      })
      setGenreResult(result)
      toast({ title: "题材已删除" })
      if (selectedGenreId === id) setSelectedGenreId("")
      setDeleteGenreId(null)
      await loadGenres()
    } catch (error) {
      toast({
        title: "删除题材失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function loadAnalyses() {
    setAnalysesState("loading")
    try {
      const data = await requestJSON<unknown>(ENDPOINTS.styleAnalyses())
      setAnalyses(pickArray(data, ["analyses", "items"]))
      setAnalysesState("ready")
    } catch {
      setAnalyses([])
      setAnalysesState("error")
    }
  }

  function requestImportReference(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = referenceText.trim()
    if (!text) return
    setMutationConfirmAction("import:text")
  }

  async function importReference() {
    const title = referenceTitle.trim() || "参考素材"
    const text = referenceText.trim()
    if (!text) return
    setBusy("import:text")
    try {
      const result = await requestJSON(ENDPOINTS.vaultImportText(), {
        method: "POST",
        body: JSON.stringify({ title, text, type: "reference" }),
      })
      setImportResult(result)
      setReferenceText("")
      toast({ title: "参考素材已导入" })
    } catch (error) {
      toast({
        title: "导入素材失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestImportUrl(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const url = referenceUrl.trim()
    if (!url) return
    setMutationConfirmAction("import:url")
  }

  async function importUrl() {
    const url = referenceUrl.trim()
    if (!url) return
    setBusy("import:url")
    try {
      const result = await requestJSON(ENDPOINTS.vaultImportUrl(), {
        method: "POST",
        body: JSON.stringify({
          url,
          title: referenceTitle.trim() || undefined,
          type: "reference",
        }),
      })
      setImportResult(result)
      setReferenceUrl("")
      toast({ title: "URL 素材已导入" })
    } catch (error) {
      toast({
        title: "导入 URL 失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestAnalyzeStyle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = styleText.trim()
    if (!text) return
    setMutationConfirmAction("import:style")
  }

  async function analyzeStyle() {
    const text = styleText.trim()
    if (!text) return
    setBusy("import:style")
    try {
      const result = await requestJSON(ENDPOINTS.styleAnalyze(), {
        method: "POST",
        body: JSON.stringify({
          text,
          sourceName: styleSource.trim() || "Web 风格样本",
          save: true,
        }),
      })
      setImportResult(result)
      toast({ title: "文风分析已完成" })
      await loadAnalyses()
    } catch (error) {
      toast({
        title: "文风分析失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestImportStyleToBook() {
    if (!selectedBookId || !styleText.trim()) return
    setMutationConfirmAction("import:book-style")
  }

  async function importStyleToBook() {
    if (!selectedBookId || !styleText.trim()) return
    setBusy("import:book-style")
    try {
      const result = await requestJSON(ENDPOINTS.bookStyleImport(selectedBookId), {
        method: "POST",
        body: JSON.stringify({
          text: styleText.trim(),
          sourceName: styleSource.trim() || "Web 风格样本",
        }),
      })
      setImportResult(result)
      toast({ title: "作品风格指纹已生成" })
    } catch (error) {
      toast({
        title: "导入作品风格失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestSyncBooks() {
    setMutationConfirmAction("import:sync")
  }

  async function syncBooks() {
    setBusy("import:sync")
    try {
      const result = await requestJSON(ENDPOINTS.vaultSyncBooks(), {
        method: "POST",
        body: JSON.stringify({}),
      })
      setImportResult(result)
      toast({ title: "作品索引已同步到素材库" })
    } catch (error) {
      toast({
        title: "同步作品索引失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestDetectChapter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canDetectSelectedBook) {
      toast({
        title: "当前作品暂无可检测章节",
        description: "请选择已有章节的作品后再运行 AI 痕迹检测。",
      })
      return
    }
    const chapter = boundedDetectChapter(chapterNum, selectedBookChapterCount)
    setChapterNum(String(chapter))
    setDetectConfirmAction("chapter")
  }

  function requestDetectAll() {
    if (!canDetectSelectedBook) {
      toast({
        title: "当前作品暂无可检测章节",
        description: "请选择已有章节的作品后再运行全书检测。",
      })
      return
    }
    setDetectConfirmAction("all")
  }

  async function runDetectChapter() {
    if (!canDetectSelectedBook) {
      setDetectConfirmAction(null)
      return
    }
    const chapter = boundedDetectChapter(chapterNum, selectedBookChapterCount)
    setChapterNum(String(chapter))
    setBusy("detect:chapter")
    try {
      const result = await requestJSON(
        ENDPOINTS.bookDetectChapter(selectedBookId, chapter),
        { method: "POST", body: JSON.stringify({}) },
      )
      setDetectResult(result)
      toast({ title: `第 ${chapter} 章检测完成` })
    } catch (error) {
      toast({
        title: "章节检测失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setDetectConfirmAction(null)
      setBusy(null)
    }
  }

  async function runDetectAll() {
    if (!canDetectSelectedBook) {
      setDetectConfirmAction(null)
      toast({
        title: "当前作品暂无可检测章节",
        description: "请选择已有章节的作品后再运行全书检测。",
      })
      return
    }
    setBusy("detect:all")
    try {
      const result = await requestJSON(ENDPOINTS.bookDetectAll(selectedBookId), {
        method: "POST",
        body: JSON.stringify({}),
      })
      setDetectResult(result)
      toast({ title: "全书检测完成" })
    } catch (error) {
      toast({
        title: "全书检测失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setDetectConfirmAction(null)
      setBusy(null)
    }
  }

  async function loadDetectStats() {
    if (!selectedBookId) return
    setBusy("detect:stats")
    try {
      const result = await requestJSON(ENDPOINTS.bookDetectStats(selectedBookId))
      setDetectStats(result)
      toast({ title: "检测统计已刷新" })
    } catch (error) {
      toast({
        title: "检测统计读取失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  const genreBusy = busy?.startsWith("genres:") ?? false
  const importBusy = busy?.startsWith("import:") ?? false
  const detectBusy = busy?.startsWith("detect:") ?? false
  const selectedBook = books.find((book) => book.id === selectedBookId)
  const selectedBookChapterCount = selectedBook
    ? bookChapterCount(selectedBook)
    : 0
  const canDetectSelectedBook = Boolean(
    selectedBookId && selectedBookChapterCount > 0,
  )
  const detectChapterTarget = canDetectSelectedBook
    ? boundedDetectChapter(chapterNum, selectedBookChapterCount)
    : 1
  const detectBookTitle = selectedBook ? bookTitle(selectedBook) : "未选择作品"
  const newGenreName = newGenre.name.trim()
  const newGenreId = newGenreName
    ? (newGenre.id.trim() || slugify(newGenreName)).slice(0, 80)
    : "自动生成"
  const mutationConfirmCopy = mutationConfirmAction === "genres:create" ? {
    title: "创建题材模板？",
    body: "这会写入一个新的 Studio 题材模板,用于后续创作和平台定位。",
    meta: `题材:${newGenreName || "未命名"} · ID:${newGenreId}`,
    cancel: "继续编辑",
    action: "确认创建",
  } : mutationConfirmAction === "genres:save" ? {
    title: "保存题材模板？",
    body: "这会覆盖当前 Studio 题材模板的档案和正文。",
    meta: `题材:${genreDraft.name || selectedGenreId || "未命名"} · ID:${genreDraft.id || selectedGenreId || "unknown"}`,
    cancel: "继续检查",
    action: "确认保存",
  } : mutationConfirmAction === "genres:copy" ? {
    title: "复制题材模板？",
    body: "这会在后端创建当前题材模板的副本。",
    meta: `来源:${genreDraft.name || selectedGenreId || "未命名"} · ID:${selectedGenreId || "unknown"}`,
    cancel: "先不复制",
    action: "确认复制",
  } : mutationConfirmAction === "import:text" ? {
    title: "导入参考素材？",
    body: "这会把粘贴正文写入素材库,之后会成为作品参考资产。",
    meta: `标题:${referenceTitle.trim() || "参考素材"} · ${referenceText.trim().length} 字符`,
    cancel: "继续编辑",
    action: "确认导入",
  } : mutationConfirmAction === "import:url" ? {
    title: "抓取并导入 URL 素材？",
    body: "这会请求后端抓取 URL 内容并写入素材库。",
    meta: referenceUrl.trim() || "未填写 URL",
    cancel: "继续检查",
    action: "确认抓取",
  } : mutationConfirmAction === "import:style" ? {
    title: "分析并保存文风样本？",
    body: "这会分析当前文风样本并保存到风格样本历史。",
    meta: `样本:${styleSource.trim() || "Web 风格样本"} · ${styleText.trim().length} 字符`,
    cancel: "继续编辑",
    action: "确认分析",
  } : mutationConfirmAction === "import:book-style" ? {
    title: "写入作品风格指纹？",
    body: "这会把当前样本文风写入目标作品的风格指纹。",
    meta: `作品:${selectedBook ? bookTitle(selectedBook) : "未选择作品"} · 样本 ${styleText.trim().length} 字符`,
    cancel: "先不写入",
    action: "确认写入",
  } : mutationConfirmAction === "import:sync" ? {
    title: "同步作品索引到素材库？",
    body: "这会让后端刷新作品索引和素材库之间的映射。",
    meta: `当前作品数:${books.length}`,
    cancel: "先不同步",
    action: "确认同步",
  } : null

  const runConfirmedMutation = async () => {
    const action = mutationConfirmAction
    if (!action) return
    setMutationConfirmAction(null)
    if (action === "genres:create") {
      await createGenre()
    } else if (action === "genres:save") {
      await saveGenre()
    } else if (action === "genres:copy") {
      await copyGenre()
    } else if (action === "import:text") {
      await importReference()
    } else if (action === "import:url") {
      await importUrl()
    } else if (action === "import:style") {
      await analyzeStyle()
    } else if (action === "import:book-style") {
      await importStyleToBook()
    } else {
      await syncBooks()
    }
  }

  return (
    <section className="cap-workbench border-border bg-card min-w-0 rounded-lg border p-4 sm:p-5">
      <span className="cap-workbench-prop" aria-hidden="true" />
      <header className="cap-workbench-head flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="cap-workbench-copy min-w-0">
          <div className="cap-workbench-kicker text-muted-foreground flex items-center gap-2 text-xs font-medium">
            <Wand2 className="size-3.5" />
            编辑部能力台
          </div>
          <h2 className="cap-workbench-title text-foreground mt-1 text-base font-semibold">
            可操作能力面板
          </h2>
          <p className="cap-workbench-desc text-muted-foreground mt-1 max-w-3xl text-xs leading-5">
            题材库、素材导入、文风学习和 AI 检测都在这里落到真实写入动作；每次改动前先确认，像编辑部桌面上一排有分工的小工具。
          </p>
          <div className="mt-3 flex min-w-0 flex-wrap gap-2">
            <StatusPill label="作品" state={booksState} count={books.length} />
            <StatusPill label="题材" state={genresState} count={genres.length} />
            <StatusPill
              label="风格样本"
              state={analysesState}
              count={analyses.length}
            />
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void loadBooks()
            void loadGenres()
            void loadAnalyses()
          }}
        >
          <RefreshCw className="size-4" />
          刷新全部
        </Button>
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as WorkbenchTab)}
        className="mt-5"
      >
        <TabsList className="cap-tabs grid w-full grid-cols-3 sm:w-auto">
          <TabsTrigger value="genres">
            <Tags className="size-4" />
            题材库
          </TabsTrigger>
          <TabsTrigger value="import">
            <FileInput className="size-4" />
            导入台
          </TabsTrigger>
          <TabsTrigger value="detect">
            <ScanSearch className="size-4" />
            检测台
          </TabsTrigger>
        </TabsList>

        <TabsContent value="genres" className="mt-4">
          <div className="grid min-w-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              <form
                onSubmit={requestCreateGenre}
                className="cap-card border-border bg-card min-w-0 rounded-lg border p-4"
              >
                <h3 className="text-foreground text-sm font-semibold">
                  新建题材模板
                </h3>
                <div className="mt-3 grid gap-3">
                  <Field label="题材名">
                    <Input
                      ref={newGenreNameRef}
                      value={newGenre.name}
                      onChange={(event) =>
                        setNewGenre((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="例如：都市脑控悬疑"
                    />
                  </Field>
                  <Field label="ID">
                    <Input
                      value={newGenre.id}
                      onChange={(event) =>
                        setNewGenre((current) => ({
                          ...current,
                          id: event.target.value,
                        }))
                      }
                      placeholder="留空自动生成"
                    />
                  </Field>
                  <Field label="语言">
                    <Input
                      value={newGenre.language}
                      onChange={(event) =>
                        setNewGenre((current) => ({
                          ...current,
                          language: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={genreBusy || !newGenre.name.trim()}
                  >
                    {busy === "genres:create" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Tags className="size-4" />
                    )}
                    创建
                  </Button>
                </div>
              </form>

              <div className="cap-card border-border bg-card min-w-0 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-foreground text-sm font-semibold">
                    已有题材
                  </h3>
                  <Badge variant="secondary">{genres.length}</Badge>
                </div>
                <div className="mt-3 max-h-[420px] space-y-2 overflow-auto pr-1">
                  {genresState === "loading" ? (
                    <p className="text-muted-foreground text-xs">
                      题材库读取中，稍等一下就能编辑。
                    </p>
                  ) : genresState === "error" ? (
                    <p className="text-destructive text-xs">
                      题材库读取失败，请检查后端或点击刷新全部重试。
                    </p>
                  ) : genres.length === 0 ? (
                    <div className="cap-empty-state">
                      <div className="cap-empty-art">
                        <EmptyArt variant="genres" />
                      </div>
                      <div className="cap-empty-title">题材架还在等第一张标签</div>
                      <p className="cap-empty-desc">
                        先建立一套 project-level 模板,写清平台定位、爽点节奏和审核风险,后面的选题与多平台改稿才有准星。
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => newGenreNameRef.current?.focus()}
                      >
                        <Tags className="size-4" />
                        创建第一套题材
                      </Button>
                    </div>
                  ) : (
                    genres.map((genre, index) => {
                      const id = genreId(genre)
                      const active = id === selectedGenreId
                      return (
                        <button
                          key={id || index}
                          type="button"
                          className={[
                            "cap-list-row border-border hover:bg-secondary flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                            active ? "bg-secondary text-foreground" : "bg-card",
                          ].join(" ")}
                          onClick={() => {
                            setSelectedGenreId(id)
                            void loadGenreDetail(id)
                          }}
                        >
                          <span className="min-w-0">
                            <span className="text-foreground block truncate text-sm font-medium">
                              {genreName(genre)}
                            </span>
                            <span className="text-muted-foreground block truncate font-mono text-[10px]">
                              {id || "unknown"}
                            </span>
                          </span>
                          {active && <Badge variant="secondary">编辑中</Badge>}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            <form
              onSubmit={requestSaveGenre}
              className="cap-card border-border bg-card min-w-0 rounded-lg border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-foreground text-sm font-semibold">
                    题材编辑
                  </h3>
                  <p className="text-muted-foreground mt-1 text-xs">
                    保存会写回 project-level `genres/*.md`。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={requestCopyGenre}
                    disabled={!selectedGenreId || genreBusy}
                  >
                    <Copy className="size-4" />
                    复制
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={requestDeleteGenre}
                    disabled={!selectedGenreId || genreBusy}
                  >
                    <Trash2 className="size-4" />
                    删除
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!genreDraft.id || genreBusy}
                  >
                    {busy === "genres:save" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    保存
                  </Button>
                </div>
              </div>

              <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-4">
                <Field label="ID">
                  <Input
                    value={genreDraft.id}
                    onChange={(event) =>
                      setGenreDraft((current) => ({
                        ...current,
                        id: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="题材名">
                  <Input
                    value={genreDraft.name}
                    onChange={(event) =>
                      setGenreDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="语言">
                  <Input
                    value={genreDraft.language}
                    onChange={(event) =>
                      setGenreDraft((current) => ({
                        ...current,
                        language: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="节奏规则">
                  <Input
                    value={genreDraft.pacingRule}
                    onChange={(event) =>
                      setGenreDraft((current) => ({
                        ...current,
                        pacingRule: event.target.value,
                      }))
                    }
                    placeholder="例如：3 段一钩"
                  />
                </Field>
              </div>

              <Field label="题材正文" className="mt-4">
                <Textarea
                  value={genreBody}
                  onChange={(event) => setGenreBody(event.target.value)}
                  className="min-h-[320px] font-mono text-xs leading-5"
                  placeholder="# 题材说明&#10;&#10;## 平台定位&#10;## 爽点节奏&#10;## 审核风险"
                />
              </Field>

              <ResultPanel
                title="最近题材操作"
                value={genreResult}
                loading={busy?.startsWith("genres:")}
              />
            </form>
          </div>
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <form
                onSubmit={requestImportReference}
                className="cap-card border-border bg-card min-w-0 rounded-lg border p-4"
              >
                <h3 className="text-foreground text-sm font-semibold">
                  导入参考素材
                </h3>
                <div className="mt-3 grid gap-3">
                  <Field label="素材标题">
                    <Input
                      value={referenceTitle}
                      onChange={(event) => setReferenceTitle(event.target.value)}
                      placeholder="例如：番茄脑洞热榜拆解"
                    />
                  </Field>
                  <Field label="粘贴正文">
                    <Textarea
                      value={referenceText}
                      onChange={(event) => setReferenceText(event.target.value)}
                      className="min-h-[220px]"
                      placeholder="粘贴市场素材、同类文拆解、设定参考..."
                    />
                  </Field>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={importBusy || !referenceText.trim()}
                  >
                    {busy === "import:text" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <FileInput className="size-4" />
                    )}
                    导入到素材库
                  </Button>
                </div>
              </form>

              <form
                onSubmit={requestAnalyzeStyle}
                className="cap-card border-border bg-card min-w-0 rounded-lg border p-4"
              >
                <h3 className="text-foreground text-sm font-semibold">
                  文风学习与导入
                </h3>
                <div className="mt-3 grid gap-3">
                  <Field label="样本名">
                    <Input
                      value={styleSource}
                      onChange={(event) => setStyleSource(event.target.value)}
                      placeholder="例如:主角第 1-5 章的叙述语气"
                    />
                  </Field>
                  <Field label="目标作品">
                    <NativeSelect
                      value={selectedBookId}
                      onChange={selectBook}
                      options={books.map((book) => ({
                        value: book.id,
                        label: bookTitle(book),
                      }))}
                      placeholder={bookSelectPlaceholder(booksState)}
                      disabled={booksState === "loading" || importBusy}
                    />
                  </Field>
                  <Field label="风格样本">
                    <Textarea
                      value={styleText}
                      onChange={(event) => setStyleText(event.target.value)}
                      className="min-h-[180px]"
                      placeholder="粘贴要学习的文风样本..."
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={importBusy || !styleText.trim()}
                    >
                      {busy === "import:style" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Wand2 className="size-4" />
                      )}
                      分析并保存
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={requestImportStyleToBook}
                      disabled={
                        importBusy ||
                        !styleText.trim() ||
                        !selectedBookId
                      }
                    >
                      <Save className="size-4" />
                      写入作品
                    </Button>
                  </div>
                </div>
              </form>

              <form
                onSubmit={requestImportUrl}
                className="cap-card border-border bg-card min-w-0 rounded-lg border p-4 lg:col-span-2"
              >
                <div className="flex min-w-0 flex-wrap items-end gap-3">
                  <Field label="URL 素材" className="min-w-0 flex-1 sm:min-w-[240px]">
                    <Input
                      value={referenceUrl}
                      onChange={(event) => setReferenceUrl(event.target.value)}
                      placeholder="https://..."
                    />
                  </Field>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={importBusy || !referenceUrl.trim()}
                  >
                    {busy === "import:url" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <FileInput className="size-4" />
                    )}
                    抓取导入
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={requestSyncBooks}
                    disabled={importBusy}
                  >
                    <RefreshCw className="size-4" />
                    同步作品索引
                  </Button>
                </div>
              </form>
            </div>

            <aside className="min-w-0 space-y-4">
              <div className="cap-card border-border bg-card min-w-0 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-foreground text-sm font-semibold">
                    风格样本历史
                  </h3>
                  <Badge variant="secondary">{analyses.length}</Badge>
                </div>
                <div className="mt-3 max-h-[260px] space-y-2 overflow-auto pr-1">
                  {analysesState === "loading" ? (
                    <p className="text-muted-foreground text-xs">
                      正在读取已保存样本...
                    </p>
                  ) : analysesState === "error" ? (
                    <p className="text-destructive text-xs">
                      样本历史读取失败；新分析仍可尝试保存。
                    </p>
                  ) : analyses.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      暂无已保存风格样本。
                    </p>
                  ) : (
                    analyses.map((analysis, index) => (
                      <div
                        key={analysisKey(analysis, index)}
                        className="cap-sample-card border-border bg-card rounded-lg border p-3"
                      >
                        <div className="text-foreground truncate text-sm font-medium">
                          {analysisTitle(analysis)}
                        </div>
                        <div className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
                          {analysisPreview(analysis)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <ResultPanel
                title="最近导入结果"
                value={importResult}
                loading={busy?.startsWith("import:")}
              />
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="detect" className="mt-4">
          <div className="grid min-w-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <form
              onSubmit={requestDetectChapter}
              className="cap-card border-border bg-card min-w-0 rounded-lg border p-4"
            >
              <h3 className="text-foreground text-sm font-semibold">
                AI 痕迹检测
              </h3>
              <div className="mt-3 grid gap-3">
                <Field label="目标作品">
                    <NativeSelect
                      value={selectedBookId}
                      onChange={selectBook}
                      options={books.map((book) => ({
                        value: book.id,
                        label: bookTitle(book),
                      }))}
                      placeholder={bookSelectPlaceholder(booksState)}
                      disabled={booksState === "loading" || detectBusy}
                    />
                </Field>
                <Field label="章节号">
                  <Input
                    type="number"
                    min={1}
                    max={selectedBookChapterCount || undefined}
                    value={chapterNum}
                    onChange={(event) => setChapterNum(event.target.value)}
                    disabled={detectBusy || !canDetectSelectedBook}
                  />
                  {!canDetectSelectedBook ? (
                    <p className="text-muted-foreground text-xs">
                      当前作品还没有章节，检测动作已暂停，避免空请求打到后端。
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      可检测 1-{selectedBookChapterCount} 章，超出范围会自动收拢。
                    </p>
                  )}
                </Field>
                <Button
                  type="submit"
                  size="sm"
                  disabled={detectBusy || !canDetectSelectedBook}
                >
                  {busy === "detect:chapter" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ScanSearch className="size-4" />
                  )}
                  检测本章
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={requestDetectAll}
                  disabled={detectBusy || !canDetectSelectedBook}
                >
                  <Play className="size-4" />
                  全书检测
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void loadDetectStats()}
                  disabled={detectBusy || !selectedBookId}
                >
                  <RefreshCw className="size-4" />
                  刷新统计
                </Button>
              </div>
            </form>

            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <ResultPanel
                title="检测结果"
                value={detectResult}
                loading={busy === "detect:chapter" || busy === "detect:all"}
              />
              <ResultPanel
                title="历史统计"
                value={detectStats}
                loading={busy === "detect:stats"}
              />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {mutationConfirmCopy ? (
        <AlertDialog
          open={mutationConfirmAction !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setMutationConfirmAction(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{mutationConfirmCopy.title}</AlertDialogTitle>
              <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
                <span>{mutationConfirmCopy.body}</span>
                <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                  {mutationConfirmCopy.meta}
                </span>
                <span>确认前不会发起写入请求。只做查看或排版检查时保持当前状态。</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={!!busy}>
                {mutationConfirmCopy.cancel}
              </AlertDialogCancel>
              <AlertDialogAction
                type="button"
                disabled={!!busy}
                onClick={(event) => {
                  event.preventDefault()
                  void runConfirmedMutation()
                }}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {mutationConfirmCopy.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      <AlertDialog
        open={deleteGenreId !== null}
        onOpenChange={(open) => {
          if (!open && busy !== "genres:delete") setDeleteGenreId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个题材模板？</AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>
                此操作会删除 Studio 后端题材模板。确认前不会发起删除请求,删除后需要从备份或版本记录恢复。
              </span>
              <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                题材:{genreDraft.name || deleteGenreId || "未命名"} · ID:{deleteGenreId || "unknown"}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy === "genres:delete"}>
              保留题材
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={busy === "genres:delete"}
              onClick={(event) => {
                event.preventDefault()
                void confirmDeleteGenre()
              }}
            >
              {busy === "genres:delete" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  删除中...
                </>
              ) : (
                "确认删除"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={detectConfirmAction !== null}
        onOpenChange={(open) => {
          if (!open && !detectBusy) setDetectConfirmAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {detectConfirmAction === "all"
                ? "运行全书 AI 痕迹检测？"
                : `检测第 ${detectChapterTarget} 章？`}
            </AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>
                {detectConfirmAction === "all"
                  ? `这会遍历《${detectBookTitle}》的 ${selectedBookChapterCount} 章并调用 AI 痕迹检测后端,可能耗时较长、消耗模型资源,并刷新检测结果。`
                  : `这会对《${detectBookTitle}》第 ${detectChapterTarget} 章调用 AI 痕迹检测后端,可能消耗模型资源,并刷新检测结果。`}
              </span>
              <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                {detectConfirmAction === "all"
                  ? `作品:${detectBookTitle} · 范围:1-${selectedBookChapterCount} 章`
                  : `作品:${detectBookTitle} · 章节:${detectChapterTarget}/${selectedBookChapterCount}`}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={detectBusy}>
              保持当前状态
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={detectBusy}
              onClick={(event) => {
                event.preventDefault()
                if (detectConfirmAction === "all") {
                  void runDetectAll()
                } else {
                  void runDetectChapter()
                }
              }}
            >
              {detectBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  检测中...
                </>
              ) : (
                "确认检测"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function Field({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={["grid min-w-0 gap-1.5", className].filter(Boolean).join(" ")}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function NativeSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  placeholder: string
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full min-w-0 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled || options.length === 0}
    >
      {options.length === 0 ? (
        <option value="">{placeholder}</option>
      ) : (
        options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))
      )}
    </select>
  )
}

function StatusPill({
  label,
  state,
  count,
}: {
  label: string
  state: LoadState
  count: number
}) {
  const isReady = state === "ready"
  const text =
    state === "loading"
      ? `${label}读取中`
      : state === "error"
        ? `${label}异常`
        : `${label} ${count}`
  return (
    <Badge variant={isReady ? "secondary" : "outline"} className="text-[11px]">
      {text}
    </Badge>
  )
}

function ResultPanel({
  title,
  value,
  loading = false,
}: {
  title: string
  value: unknown
  loading?: boolean
}) {
  const summary = value && !loading ? summarizeResult(value) : []
  return (
    <div className="cap-card cap-result border-border bg-card mt-4 min-w-0 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-foreground text-sm font-semibold">{title}</h3>
        <Badge variant={value && !loading ? "secondary" : "outline"}>
          {loading ? "处理中" : value ? "有结果" : "等待操作"}
        </Badge>
      </div>
      {loading ? (
        <p className="text-muted-foreground mt-3 text-xs">请求处理中...</p>
      ) : !value ? (
        <p className="text-muted-foreground mt-3 text-xs">尚未执行。</p>
      ) : (
        <>
          {summary.length > 0 ? (
            <dl className="mt-3 grid gap-1.5">
              {summary.map((row) => (
                <div
                  key={row.label}
                  className="border-border/50 flex items-start justify-between gap-3 border-b py-1.5 last:border-b-0"
                >
                  <dt className="text-muted-foreground shrink-0 text-xs">
                    {row.label}
                  </dt>
                  <dd className="text-foreground min-w-0 break-words text-right text-xs font-medium">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-muted-foreground mt-3 text-xs">
              操作已返回，展开下方查看完整响应。
            </p>
          )}
          <details className="mt-3">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
              调试详情（原始响应）
            </summary>
            <pre className="text-muted-foreground mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.03] p-3 font-mono text-[11px] leading-5 dark:bg-white/[0.04]">
              {compactJSON(value)}
            </pre>
          </details>
        </>
      )}
    </div>
  )
}

type SummaryRow = { label: string; value: string }

/**
 * 把后端返回 JSON 蒸馏成关键字段成行的结构化摘要。
 * 覆盖题材 / 导入 / 文风分析 / 检测 / 检测统计等已知形态;
 * 未识别的形态返回空数组,UI 退回“展开看完整响应”。
 */
function summarizeResult(value: unknown): SummaryRow[] {
  const record = toRecord(value)
  if (!record) return []
  const rows: SummaryRow[] = []
  const push = (label: string, raw: unknown) => {
    const text = formatSummaryValue(raw)
    if (text) rows.push({ label, value: text })
  }

  // 单章 / 全书 AI 痕迹检测
  if (Array.isArray(record.results)) {
    const results = record.results as unknown[]
    let warnings = 0
    let infos = 0
    for (const item of results) {
      const issues = toRecord(item)?.issues
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          const sev = stringField(toRecord(issue)?.severity)
          if (sev === "warning") warnings += 1
          else if (sev === "info") infos += 1
        }
      }
    }
    push("检测章节数", results.length)
    push("warning 命中", warnings)
    push("info 命中", infos)
    return rows
  }
  if (Array.isArray(record.issues)) {
    const issues = record.issues as unknown[]
    const warnings = issues.filter(
      (i) => stringField(toRecord(i)?.severity) === "warning",
    ).length
    push("章节号", record.chapterNumber)
    push("问题总数", issues.length)
    push("warning", warnings)
    push("info", issues.length - warnings)
    const categories = Array.from(
      new Set(
        issues
          .map((i) => stringField(toRecord(i)?.category))
          .filter(Boolean),
      ),
    )
    if (categories.length > 0) push("命中类型", categories.join("、"))
    return rows
  }

  // 检测历史统计
  if (
    "totalDetections" in record ||
    "passRate" in record ||
    Array.isArray(record.chapterBreakdown)
  ) {
    push("检测次数", record.totalDetections)
    push("重写次数", record.totalRewrites)
    push("平均初始人味", formatScore(record.avgOriginalScore))
    push("平均终稿人味", formatScore(record.avgFinalScore))
    push("平均提升", formatScore(record.avgScoreReduction))
    push("通过率", formatPercent(record.passRate))
    if (Array.isArray(record.chapterBreakdown)) {
      push("覆盖章节", record.chapterBreakdown.length)
    }
    return rows
  }

  // 文风分析 StyleProfile
  if ("vocabularyDiversity" in record || "avgSentenceLength" in record) {
    push("样本", record.sourceName)
    push("平均句长", formatScore(record.avgSentenceLength))
    push("句长标准差", formatScore(record.sentenceLengthStdDev))
    push("平均段长", formatScore(record.avgParagraphLength))
    push("词汇多样性", formatScore(record.vocabularyDiversity))
    if (Array.isArray(record.rhetoricalFeatures)) {
      push("修辞特征", (record.rhetoricalFeatures as unknown[]).length)
    }
    if (record.saved) push("已保存", "是")
    return rows
  }

  // 素材导入
  if (typeof record.relativePath === "string") {
    push("标题", record.title)
    push("类型", record.type === "style" ? "风格样本" : "参考素材")
    push("写入路径", record.relativePath)
    return rows
  }

  // 同步作品索引
  if (Array.isArray(record.books)) {
    push("同步作品数", (record.books as unknown[]).length)
    return rows
  }

  // 题材操作(create/copy/save/delete)
  if (typeof record.id === "string" && !("profile" in record)) {
    push("题材 ID", record.id)
    if (record.ok === true) push("状态", "已完成")
    return rows
  }
  if (typeof record.path === "string") {
    push("写入路径", record.path)
    if (record.ok === true) push("状态", "已完成")
    return rows
  }
  if ("profile" in record) {
    const profile = toRecord(record.profile)
    push("题材", stringField(profile?.name) || stringField(profile?.id))
    push("ID", profile?.id)
    push("语言", profile?.language)
    if (typeof record.body === "string") {
      push("正文字数", record.body.length)
    }
    return rows
  }

  // 仅 { ok: true } 之类的轻量回执
  if (record.ok === true && Object.keys(record).length <= 2) {
    push("状态", "已完成")
    return rows
  }

  return rows
}

function formatSummaryValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "是" : "否"
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  if (typeof value === "string") return value.trim()
  return ""
}

function formatScore(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return ""
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatPercent(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return ""
  const pct = value <= 1 ? value * 100 : value
  return `${Math.round(pct)}%`
}

function bookSelectPlaceholder(state: LoadState) {
  if (state === "loading") return "作品加载中..."
  if (state === "error") return "作品读取失败"
  return "暂无作品"
}

async function requestJSON<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has("accept")) headers.set("accept", "application/json")
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  const response = await fetch(url, {
    ...init,
    headers,
    cache: "no-store",
  })
  const text = await response.text()
  const data = text ? parseJSON(text) : {}
  if (!response.ok) {
    throw new Error(extractError(data) || `HTTP ${response.status}`)
  }
  return data as T
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function pickArray(data: unknown, keys: string[]) {
  if (Array.isArray(data)) return data
  const record = toRecord(data)
  if (!record) return []
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : ""
}

function firstGenreId(rows: unknown[]) {
  for (const row of rows) {
    const id = genreId(row)
    if (id) return id
  }
  return ""
}

function preferredWorkbenchBook(rows: BookSummary[], tab: WorkbenchTab) {
  if (tab === "detect") {
    return (
      pickPreferredBook(rows.filter((book) => bookChapterCount(book) > 0)) ??
      pickPreferredBook(rows)
    )
  }
  return pickPreferredBook(rows)
}

function bookChapterCount(book: BookSummary) {
  return Math.max(0, book.chapterCount || 0, book.currentChapter || 0)
}

function defaultDetectChapter(book: BookSummary) {
  const count = bookChapterCount(book)
  if (count <= 0) return 1
  return boundedDetectChapter(String(book.currentChapter || count), count)
}

function boundedDetectChapter(value: string, count: number) {
  const numeric = Math.max(1, Number(value) || 1)
  return Math.min(numeric, Math.max(1, count))
}

function genreId(value: unknown) {
  if (typeof value === "string") return value
  const record = toRecord(value)
  return stringField(record?.id) || stringField(record?.slug)
}

function genreName(value: unknown) {
  if (typeof value === "string") return value
  const record = toRecord(value)
  return (
    stringField(record?.name) ||
    stringField(record?.title) ||
    stringField(record?.id) ||
    "未命名题材"
  )
}

function bookTitle(book: BookSummary) {
  return book.title.zh || book.title.en || book.id
}

function analysisKey(value: unknown, index: number) {
  const record = toRecord(value)
  return (
    stringField(record?.id) ||
    stringField(record?.relativePath) ||
    stringField(record?.title) ||
    String(index)
  )
}

function analysisTitle(value: unknown) {
  const record = toRecord(value)
  return (
    stringField(record?.title) ||
    stringField(record?.sourceName) ||
    stringField(record?.name) ||
    "未命名样本"
  )
}

function analysisPreview(value: unknown) {
  const record = toRecord(value)
  return (
    stringField(record?.preview) ||
    stringField(record?.summary) ||
    stringField(record?.relativePath) ||
    "无预览"
  )
}

function compactJSON(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function slugify(value: string) {
  const ascii = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return ascii || `genre-${Date.now()}`
}

function defaultGenreBody(name: string) {
  return `# ${name}\n\n## 平台定位\n\n## 爽点节奏\n\n`
}

function extractError(data: unknown) {
  const record = toRecord(data)
  if (!record) return ""
  if (typeof record.error === "string") return record.error
  const nested = toRecord(record.error)
  if (typeof nested?.message === "string") return nested.message
  if (typeof record.message === "string") return record.message
  return ""
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
