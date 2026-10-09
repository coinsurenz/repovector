class TerminalSession {
  final String id;
  TerminalSession(this.id);

  bool isActive() => id.isNotEmpty;
}

void main() {
  print(TerminalSession('a').isActive());
}
