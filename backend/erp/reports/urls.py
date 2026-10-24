from django.urls import path

from . import views

urlpatterns = [
    path("", views.LibraryView.as_view(), name="reports-library"),
    path("overview/", views.OverviewView.as_view(), name="reports-overview"),
    path("<slug:key>/", views.ReportView.as_view(), name="report"),
]
