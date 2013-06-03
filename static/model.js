"use strict";

function MessageModel(apiRoot, socket) {
  this.socket_ = socket;
  this.apiRoot_ = apiRoot;
}
MessageModel.prototype.socket = function() {
  return this.socket_;
};
MessageModel.prototype.apiRequest = function(method, path, data) {
  var url = this.apiRoot_ + path;
  var xhr = new XMLHttpRequest();
  if ("withCredentials" in xhr) {
    // XHR for Chrome/Firefox/Opera/Safari.
    xhr.open(method, url, true);
  } else if (typeof XDomainRequest != "undefined") {
    // XDomainRequest for IE.
    xhr = new XDomainRequest();
    xhr.open(method, url);
  } else {
    return Q.reject("CORS not supported.");
  }

  var deferred = Q.defer();
  xhr.onload = function() {
    if (this.status == 200) {
      deferred.resolve(JSON.parse(xhr.responseText));
    } else {
      deferred.reject(this.statusText);
    }
  };
  xhr.onerror = function() {
    deferred.reject("Request failed");
  };

  if (data !== undefined) {
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(data));
  } else {
    xhr.send();
  }
  return deferred.promise;
};
MessageModel.prototype.newTailInclusive = function(start, cb) {
  return new MessageTail(this, start, true, cb);
};
MessageModel.prototype.newTail = function(start, cb) {
  return new MessageTail(this, start, false, cb);
};
MessageModel.prototype.newReverseTail = function(start, cb) {
  return new MessageReverseTail(this, start, cb);
};
// This function is NOT meant to be that authoritative. It's just
// because some places in the message view would find it handle to be
// able to compare messages to each other and opaque message ids as a
// data model make this difficult.
MessageModel.prototype.compareMessages = function(a, b) {
  return a.receiveTime - b.receiveTime;
};

// TODO(davidben): This really really should be state that's attached
// to the socket. Wrap io.socket's objects in some wrapper that
// maintains a |nextTailId_| property.
var nextTailId = 1;

function MessageTail(model, start, inclusive, cb) {
  this.model_ = model;
  // The last thing we sent.
  this.lastSent_ = start;
  // Whether the request is inclusive.
  this.inclusive_ = inclusive;
  // The number of messages sent total.
  this.messagesSentTotal_ = 0;
  // The number of messages sent since the last new-tail.
  this.messagesSentRecent_ = 0;
  // The number of messages we want ahead of lastSent_.
  this.messagesWanted_ = 0;
  // Callback. null on close.
  this.cb_ = cb;

  // Hold onto this so we can unregister it.
  this.messagesCb_ = this.onMessages_.bind(this);
  this.model_.socket().on("messages", this.messagesCb_);

  this.createTail_();
}
MessageTail.prototype.expandTo = function(count) {
  this.messagesWanted_ = Math.max(this.messagesWanted_,
                                  count - this.messagesSentTotal_);
  this.model_.socket().emit("extend-tail", this.tailId_,
                            this.messagesWanted_ + this.messagesSentRecent_);
};
MessageTail.prototype.close = function() {
  this.cb_ = null;
  this.model_.socket().removeListener("messages", this.messagesCb_);
};
MessageTail.prototype.createTail_ = function() {
  this.tailId_ = nextTailId++;
  this.messagesSentRecent_ = 0;  // New tail, so we reset offset.
  this.model_.socket().emit("new-tail",
                            this.tailId_, this.lastSent_, this.inclusive_);
};
MessageTail.prototype.onMessages_ = function(id, msgs, isDone) {
  if (id != this.tailId_)
    return;
  if (msgs.length) {
    this.lastSent_ = msgs[msgs.length - 1].id;
    this.inclusive_ = false;
    this.messagesSentTotal_ += msgs.length;
    this.messagesSentRecent_ += msgs.length;
    this.messagesWanted -= msgs.length;
  }
  if (this.cb_)
    this.cb_(msgs, isDone);
};

function MessageReverseTail(model, start, cb) {
  this.model_ = model;
  this.start_ = start;
  this.messagesSent_ = 0;
  this.messagesWanted_ = 0;
  this.cb_ = cb;
  this.pending_ = false;
}
MessageReverseTail.prototype.expandTo = function(count) {
  this.messagesWanted_ = Math.max(this.messagesWanted_,
                                  count - this.messagesSent_);
  this.fireRequest_();
};
MessageReverseTail.prototype.close = function() {
  this.cb_ = null;
};
MessageReverseTail.prototype.fireRequest_ = function() {
  if (this.pending_ || !this.cb_ || this.messagesWanted_ == 0)
    return;
  var path = "/messages?reverse=1";
  if (this.start_ != null)
    path += "&offset=" + encodeURIComponent(this.start_);
  path += "&count=" + String(this.messagesWanted_);
  
  // TODO(davidben): Error handling!
  this.pending_ = true;
  this.model_.apiRequest("GET", path).then(function(resp) {
    // Bleh. The widget code wants the messages in reverse order.
    resp.messages.reverse();

    if (this.cb_)
      this.cb_(resp.messages, resp.isDone);

    // Update fields (specifically |pending_|) AFTER the callback to
    // ensure they don't fire a new request; we might know there's no
    // use in continuing.
    this.pending_ = false;
    if (resp.messages.length)
      this.start_ = resp.messages[0].id;
    this.messagesSent_ += resp.messages.length;
    this.messagesWanted_ -= resp.messages.length;

    // We're done. Shut everything off.
    if (resp.isDone) {
      this.close();
    } else {
      // Keep going if needbe.
      this.fireRequest_();
    }
  }.bind(this)).done();
};