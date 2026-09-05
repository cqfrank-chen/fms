// 候选①：frappe-gantt 1.2.2（MIT）——行级任务块渲染/拖拽/回调/配色/日周月视图
declare module 'frappe-gantt' {
  export interface FrappeTask {
    id: string | number;
    name: string;
    start: string;
    end: string;
    progress?: number; // 0-100
    color?: string;
    color_progress?: string;
    custom_class?: string;
    [k: string]: unknown;
  }
  export interface FrappeGanttOptions {
    view_mode?: string;
    view_modes?: Array<{ name: string }>;
    language?: string;
    popup?: false | ((args: { task: FrappeTask; chart: unknown; add_action: (html: string, fn: () => void) => void }) => string | false | void);
    on_click?: (task: FrappeTask) => void;
    on_date_change?: (task: FrappeTask, start: Date, end: Date) => void;
    on_progress_change?: (task: FrappeTask, progress: number) => void;
    on_view_change?: (mode: string) => void;
    readonly?: boolean;
    readonly_dates?: boolean;
    readonly_progress?: boolean;
    fixed_duration?: boolean;
    snap_at?: string;
    [k: string]: unknown;
  }
  export default class Gantt {
    constructor(el: string | HTMLElement, tasks: FrappeTask[], options?: FrappeGanttOptions);
    change_view_mode(mode: string, maintain_pos?: boolean): void;
    update_task(id: string | number, details: Partial<FrappeTask>): void;
    scroll_current(): void;
  }
}
