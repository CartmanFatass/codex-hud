/* Synthetic native Claude target, NOT a vendor client or provider test.
 * Keep this native process as the verified harness. Each hook is a fresh direct
 * child so the existing outermost-hook start-time proof remains real.
 * Build only inside a test-owned directory, naming the executable `claude`.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int send_all(int fd, const char *bytes, size_t size) {
  while (size) {
    ssize_t written = write(fd, bytes, size);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    bytes += written;
    size -= (size_t)written;
  }
  return 0;
}
static int reap(pid_t pid) {
  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 125;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
static int hook(const char *node, const char *script, const char *config, const char *input) {
  int pipefd[2];
  if (pipe(pipefd) != 0) return 125;
  pid_t pid = fork();
  if (pid < 0) { close(pipefd[0]); close(pipefd[1]); return 125; }
  if (pid == 0) {
    if (dup2(pipefd[0], STDIN_FILENO) < 0) _exit(125);
    if (pipefd[0] != STDIN_FILENO) close(pipefd[0]);
    if (pipefd[1] != STDIN_FILENO) close(pipefd[1]);
    for (int fd = 3; fd < 256; fd++) close(fd);
    alarm(5);
    execl(node, node, script, config, (char *)NULL);
    _exit(127);
  }
  close(pipefd[0]);
  int wrote = send_all(pipefd[1], input, strlen(input));
  close(pipefd[1]);
  int status = reap(pid);
  return wrote == 0 ? status : 125;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("2.1.305 (SYNTHETIC native target fixture)");
    return 0;
  }
  const char *repo = getenv("SYNTHETIC_CLAUDE_REPO");
  const char *node = getenv("SYNTHETIC_CLAUDE_NODE");
  if (!repo || repo[0] != '/' || !node || node[0] != '/') return 125;
  char controller[8192], helper[8192];
  if (snprintf(controller, sizeof(controller), "%s/tests/fixtures/claude-managed-target-controller.mjs", repo) >= (int)sizeof(controller) ||
      snprintf(helper, sizeof(helper), "%s/packages/hud-mcp/bin/hud-claude-hook.mjs", repo) >= (int)sizeof(helper)) return 125;
  int request[2], response[2];
  if (pipe(request) != 0 || pipe(response) != 0) return 125;
  signal(SIGPIPE, SIG_IGN);
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    /* request[1] is fd4, response[0] is fd5 with normal inherited stdio. */
    int writer = dup(request[1]), reader = dup(response[0]);
    if (writer < 0 || reader < 0 || dup2(writer, 3) < 0 || dup2(reader, 4) < 0) _exit(125);
    for (int fd = 5; fd < 256; fd++) close(fd);
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    if (!args) _exit(125);
    args[0] = (char *)node; args[1] = controller;
    for (int index = 1; index < argc; index++) args[index + 1] = argv[index];
    execv(node, args);
    _exit(127);
  }
  close(request[1]); close(response[0]); close(STDIN_FILENO);
  FILE *commands = fdopen(request[0], "r"), *answers = fdopen(response[1], "w");
  if (!commands || !answers) { kill(child, SIGTERM); return reap(child); }
  char config[8192], input[262146];
  while (fgets(config, sizeof(config), commands)) {
    size_t config_size = strlen(config);
    if (config_size < 2 || config[0] != '/' || config[config_size - 1] != '\n') { kill(child, SIGTERM); break; }
    config[config_size - 1] = '\0';
    if (!fgets(input, sizeof(input), commands)) { kill(child, SIGTERM); break; }
    size_t size = strlen(input);
    if (size == 0 || input[size - 1] != '\n') { kill(child, SIGTERM); break; }
    int status = hook(node, helper, config, input);
    if (fprintf(answers, "%d\n", status) < 0 || fflush(answers) != 0) break;
  }
  fclose(commands); fclose(answers);
  return reap(child);
}
