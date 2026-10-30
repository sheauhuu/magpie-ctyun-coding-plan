import { CredentialStore, credentialId } from '../src/credentials.mjs';
const account = process.argv.slice(2).join(' ').trim();
if (!account) { console.error('请提供登录时使用的账号名称'); process.exitCode = 1; }
else {
  try {
    const removed = await new CredentialStore().remove(credentialId(account));
    console.log(removed ? '已移除该账号在本插件系统凭据库中的条目' : '该账号没有已保存的密码条目');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
