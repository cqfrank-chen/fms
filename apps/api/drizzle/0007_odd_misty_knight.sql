CREATE TABLE "processes" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"wc_key" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "processes_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "product_processes" (
	"product_id" integer NOT NULL,
	"process_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"unit_seconds" numeric(8, 2),
	"changeover_minutes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_centers" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"machines" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_sheet_lines" ADD COLUMN "wc_key" text;--> statement-breakpoint
ALTER TABLE "plan_sheet_lines" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "plan_sheet_lines" ADD COLUMN "cover_days" integer;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_wc_key_work_centers_key_fk" FOREIGN KEY ("wc_key") REFERENCES "public"."work_centers"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_processes" ADD CONSTRAINT "product_processes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_processes" ADD CONSTRAINT "product_processes_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_processes_pk" ON "product_processes" USING btree ("product_id","process_id");--> statement-breakpoint

-- 种子：6 工作中心（看板纵轴泳道）+ 13 工序字典（spec §5 / research/04）
INSERT INTO work_centers(key,name,machines,sort_order) VALUES
  ('cut','下料',2,10),
  ('turn','车削',2,20),
  ('drill','钻孔(丙烷分列)',1,40),
  ('thread','螺纹',1,50),
  ('finish','抛光/清洗',1,60),
  ('pack','测试/包装',2,70)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO processes(key,name,wc_key,sort_order) VALUES
  ('iqc','来料检验','pack',5),
  ('cut','下料','cut',10),
  ('turn','车削外形','turn',20),
  ('drill_c','钻中心孔','drill',30),
  ('drill_p','钻预热孔','drill',40),
  ('thread','攻丝/车螺纹','thread',50),
  ('mill','铣削','turn',60),
  ('braze','钎焊','turn',70),
  ('ream','铰孔/精加工','turn',80),
  ('polish','抛光','finish',90),
  ('wash','清洗去油','finish',100),
  ('test','气密/流量测试','pack',110),
  ('pack','包装入库','pack',120)
ON CONFLICT (key) DO NOTHING;