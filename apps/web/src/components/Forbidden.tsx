import { Button, Result } from 'antd'
import { HOME_PATH, navigate } from '../lib/router'

/** 403 提示页：登录用户访问其角色不可见的页面时展示（菜单已过滤，此处兜底手改 URL/越权跳转） */
export default function Forbidden({ title }: { title?: string }) {
  return (
    <Result
      status="403"
      title="403 无访问权限"
      subTitle={
        title
          ? '当前账号无权访问「' + title + '」，如需权限请联系管理员调整角色。'
          : '当前账号无权访问该页面，如需权限请联系管理员调整角色。'
      }
      extra={
        <Button type="primary" onClick={() => navigate(HOME_PATH)}>
          返回首页
        </Button>
      }
    />
  )
}
